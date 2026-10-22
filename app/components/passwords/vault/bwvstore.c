/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* See bwvstore.h. */

#if !defined(_WIN32) && !defined(_GNU_SOURCE)
#  define _GNU_SOURCE 1
#endif

#include "bwvstore.h"

#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#  include <windows.h>
#  include <aclapi.h>
#else
#  include <errno.h>
#  include <fcntl.h>
#  include <stdio.h> /* renameat */
#  include <sys/file.h>
#  include <sys/stat.h>
#  include <unistd.h>
#endif

#define LOCK_NAME "vault.lock"
#define TMP_SUFFIX ".tmp"
#define MAX_NAME 64
#define MAX_FILE (80u * 1024u * 1024u)

/* `name` + ".tmp" into `out` (MAX_NAME + sizeof(TMP_SUFFIX) bytes). */
static int tmp_name_of(const char* name, char* out) {
  size_t n = strlen(name);
  if (n > MAX_NAME) {
    return 0;
  }
  memcpy(out, name, n);
  memcpy(out + n, TMP_SUFFIX, sizeof(TMP_SUFFIX));
  return 1;
}

/* ======================================================================
 * Windows
 * ====================================================================== */
#ifdef _WIN32

struct bws_store {
  wchar_t* dir;
  HANDLE lock;
  PSECURITY_DESCRIPTOR sd; /* the user-only descriptor, for new files */
  PACL acl;
};

static wchar_t* widen(const char* s) {
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, NULL, 0);
  if (n <= 0) {
    return NULL;
  }
  wchar_t* w = (wchar_t*)malloc((size_t)n * sizeof(wchar_t));
  if (w && MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, w, n) <= 0) {
    free(w);
    return NULL;
  }
  return w;
}

static wchar_t* path_of(const bws_store* store, const char* name) {
  wchar_t* wname = widen(name);
  if (!wname) {
    return NULL;
  }
  size_t a = wcslen(store->dir), b = wcslen(wname);
  wchar_t* p = (wchar_t*)malloc((a + b + 2) * sizeof(wchar_t));
  if (p) {
    memcpy(p, store->dir, a * sizeof(wchar_t));
    p[a] = L'\\';
    memcpy(p + a + 1, wname, (b + 1) * sizeof(wchar_t));
  }
  free(wname);
  return p;
}

/* A protected DACL with a single entry: the current user, full control
 * (inherited by files in the directory). */
static int make_user_only(bws_store* store) {
  HANDLE token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    return 0;
  }
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, NULL, 0, &size);
  TOKEN_USER* user = (TOKEN_USER*)malloc(size);
  int ok = user && GetTokenInformation(token, TokenUser, user, size, &size);
  CloseHandle(token);
  if (ok) {
    DWORD acl_size = sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) +
                     GetLengthSid(user->User.Sid);
    store->acl = (PACL)malloc(acl_size);
    store->sd = (PSECURITY_DESCRIPTOR)malloc(SECURITY_DESCRIPTOR_MIN_LENGTH);
    ok = store->acl && store->sd &&
         InitializeAcl(store->acl, acl_size, ACL_REVISION) &&
         AddAccessAllowedAceEx(store->acl, ACL_REVISION,
                               OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
                               GENERIC_ALL, user->User.Sid) &&
         InitializeSecurityDescriptor(store->sd, SECURITY_DESCRIPTOR_REVISION) &&
         SetSecurityDescriptorDacl(store->sd, TRUE, store->acl, FALSE) &&
         SetSecurityDescriptorControl(store->sd, SE_DACL_PROTECTED,
                                      SE_DACL_PROTECTED);
  }
  free(user);
  return ok;
}

/* Set the user-only DACL on an existing file or directory. */
static int restrict_path(bws_store* store, const wchar_t* path) {
  return SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                               DACL_SECURITY_INFORMATION |
                                   PROTECTED_DACL_SECURITY_INFORMATION,
                               NULL, NULL, store->acl, NULL) == ERROR_SUCCESS;
}

static int is_reparse(const wchar_t* path) {
  DWORD attrs = GetFileAttributesW(path);
  return attrs != INVALID_FILE_ATTRIBUTES &&
         (attrs & FILE_ATTRIBUTE_REPARSE_POINT);
}

static void close_store(bws_store* store) {
  if (store->lock && store->lock != INVALID_HANDLE_VALUE) {
    CloseHandle(store->lock);
  }
  free(store->dir);
  free(store->sd);
  free(store->acl);
  free(store);
}

void bws_close(bws_store* store) {
  if (store) {
    close_store(store);
  }
}

int bws_exists(bws_store* store, const char* name) {
  wchar_t* path = path_of(store, name);
  int exists = path && GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES;
  free(path);
  return exists;
}

bwv_status bws_read(bws_store* store, const char* name, uint8_t** data,
                    size_t* len) {
  wchar_t* path = path_of(store, name);
  if (!path) {
    return BWV_E_NOMEM;
  }
  if (is_reparse(path)) {
    free(path);
    return BWV_E_IO;
  }
  HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL,
                         OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  free(path);
  if (h == INVALID_HANDLE_VALUE) {
    DWORD err = GetLastError();
    return err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND
               ? BWV_E_NOT_FOUND
               : BWV_E_IO;
  }
  LARGE_INTEGER size;
  bwv_status status = BWV_OK;
  uint8_t* buf = NULL;
  if (!GetFileSizeEx(h, &size) || size.QuadPart > MAX_FILE) {
    status = BWV_E_IO;
  } else {
    buf = (uint8_t*)malloc(size.QuadPart ? (size_t)size.QuadPart : 1);
    DWORD got = 0;
    if (!buf) {
      status = BWV_E_NOMEM;
    } else if (size.QuadPart &&
               (!ReadFile(h, buf, (DWORD)size.QuadPart, &got, NULL) ||
                got != (DWORD)size.QuadPart)) {
      status = BWV_E_IO;
    }
  }
  CloseHandle(h);
  if (status != BWV_OK) {
    free(buf);
    return status;
  }
  *data = buf;
  *len = (size_t)size.QuadPart;
  return BWV_OK;
}

static bwv_status move_over(const wchar_t* from, const wchar_t* to) {
  /* A virus scanner or an indexer may hold the destination for a moment. */
  for (int attempt = 0; attempt < 10; attempt++) {
    if (MoveFileExW(from, to, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
      return BWV_OK;
    }
    DWORD err = GetLastError();
    if (err != ERROR_SHARING_VIOLATION && err != ERROR_ACCESS_DENIED &&
        err != ERROR_LOCK_VIOLATION) {
      break;
    }
    Sleep(50);
  }
  return BWV_E_IO;
}

static bwv_status write_new_file(bws_store* store, const wchar_t* path,
                                 const uint8_t* data, size_t len) {
  DeleteFileW(path);
  SECURITY_ATTRIBUTES sa = {sizeof(sa), store->sd, FALSE};
  HANDLE h = CreateFileW(path, GENERIC_WRITE, 0, &sa, CREATE_NEW,
                         FILE_ATTRIBUTE_NORMAL, NULL);
  if (h == INVALID_HANDLE_VALUE) {
    return BWV_E_IO;
  }
  size_t done = 0;
  int ok = 1;
  while (ok && done < len) {
    DWORD chunk = (DWORD)((len - done) > (1u << 30) ? (1u << 30) : (len - done));
    DWORD wrote = 0;
    ok = WriteFile(h, data + done, chunk, &wrote, NULL) && wrote == chunk;
    done += wrote;
  }
  ok = ok && FlushFileBuffers(h);
  CloseHandle(h);
  if (!ok) {
    DeleteFileW(path);
    return BWV_E_IO;
  }
  return BWV_OK;
}

bwv_status bws_replace(bws_store* store, const char* name, const uint8_t* data,
                       size_t len) {
  char tmp_name[MAX_NAME + sizeof(TMP_SUFFIX)];
  if (!tmp_name_of(name, tmp_name)) {
    return BWV_E_ARG;
  }
  wchar_t* tmp = path_of(store, tmp_name);
  wchar_t* final = path_of(store, name);
  bwv_status status = tmp && final ? write_new_file(store, tmp, data, len)
                                   : BWV_E_NOMEM;
  if (status == BWV_OK) {
    status = move_over(tmp, final);
    if (status != BWV_OK) {
      DeleteFileW(tmp);
    }
  }
  free(tmp);
  free(final);
  return status;
}

bwv_status bws_rename(bws_store* store, const char* from, const char* to) {
  wchar_t* a = path_of(store, from);
  wchar_t* b = path_of(store, to);
  bwv_status status = a && b ? move_over(a, b) : BWV_E_NOMEM;
  free(a);
  free(b);
  return status;
}

bwv_status bws_remove(bws_store* store, const char* name) {
  wchar_t* path = path_of(store, name);
  if (!path) {
    return BWV_E_NOMEM;
  }
  BOOL ok = DeleteFileW(path);
  DWORD err = ok ? 0 : GetLastError();
  free(path);
  return ok || err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND
             ? BWV_OK
             : BWV_E_IO;
}

bwv_status bws_open(const char* dir, bws_store** out, int* perms_fixed) {
  *perms_fixed = 0;
  bws_store* store = (bws_store*)calloc(1, sizeof(*store));
  if (!store) {
    return BWV_E_NOMEM;
  }
  store->dir = widen(dir);
  if (!store->dir || !make_user_only(store)) {
    close_store(store);
    return BWV_E_NOMEM;
  }
  SECURITY_ATTRIBUTES sa = {sizeof(sa), store->sd, FALSE};
  if (!CreateDirectoryW(store->dir, &sa) &&
      GetLastError() != ERROR_ALREADY_EXISTS) {
    close_store(store);
    return BWV_E_IO;
  }
  DWORD attrs = GetFileAttributesW(store->dir);
  if (attrs == INVALID_FILE_ATTRIBUTES || !(attrs & FILE_ATTRIBUTE_DIRECTORY) ||
      (attrs & FILE_ATTRIBUTE_REPARSE_POINT) || !restrict_path(store, store->dir)) {
    close_store(store);
    return BWV_E_IO;
  }
  wchar_t* lock = path_of(store, LOCK_NAME);
  store->lock = lock ? CreateFileW(lock, GENERIC_READ | GENERIC_WRITE, 0, &sa,
                                   OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL)
                     : INVALID_HANDLE_VALUE;
  DWORD err = GetLastError();
  free(lock);
  if (store->lock == INVALID_HANDLE_VALUE) {
    close_store(store);
    return err == ERROR_SHARING_VIOLATION ? BWV_E_IN_USE : BWV_E_IO;
  }
  /* What a crash may have left; never promoted. */
  const char* leftovers[] = {BWS_STAGED, BWS_VAULT TMP_SUFFIX,
                             BWS_BACKUP TMP_SUFFIX, BWS_STAGED TMP_SUFFIX,
                             BWS_CLEANUP_MARKER TMP_SUFFIX};
  for (size_t i = 0; i < sizeof(leftovers) / sizeof(leftovers[0]); i++) {
    bws_remove(store, leftovers[i]);
  }
  const char* kept[] = {BWS_VAULT, BWS_BACKUP};
  for (size_t i = 0; i < 2; i++) {
    wchar_t* path = path_of(store, kept[i]);
    if (path && GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES) {
      if (is_reparse(path) || !restrict_path(store, path)) {
        free(path);
        close_store(store);
        return BWV_E_IO;
      }
    }
    free(path);
  }
  *out = store;
  return BWV_OK;
}

/* ======================================================================
 * Linux and other POSIX systems
 * ====================================================================== */
#else

struct bws_store {
  int dirfd;
  int lockfd;
};

static void close_store(bws_store* store) {
  if (store->lockfd >= 0) {
    close(store->lockfd); /* releases the flock */
  }
  if (store->dirfd >= 0) {
    close(store->dirfd);
  }
  free(store);
}

void bws_close(bws_store* store) {
  if (store) {
    close_store(store);
  }
}

int bws_exists(bws_store* store, const char* name) {
  struct stat st;
  return fstatat(store->dirfd, name, &st, AT_SYMLINK_NOFOLLOW) == 0;
}

bwv_status bws_read(bws_store* store, const char* name, uint8_t** data,
                    size_t* len) {
  int fd = openat(store->dirfd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    return errno == ENOENT ? BWV_E_NOT_FOUND : BWV_E_IO;
  }
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_size > MAX_FILE) {
    close(fd);
    return BWV_E_IO;
  }
  size_t size = (size_t)st.st_size;
  uint8_t* buf = (uint8_t*)malloc(size ? size : 1);
  if (!buf) {
    close(fd);
    return BWV_E_NOMEM;
  }
  size_t done = 0;
  while (done < size) {
    ssize_t n = read(fd, buf + done, size - done);
    if (n < 0 && errno == EINTR) {
      continue;
    }
    if (n <= 0) {
      break;
    }
    done += (size_t)n;
  }
  close(fd);
  if (done != size) {
    free(buf);
    return BWV_E_IO;
  }
  *data = buf;
  *len = size;
  return BWV_OK;
}

static bwv_status write_new_file(bws_store* store, const char* name,
                                 const uint8_t* data, size_t len) {
  unlinkat(store->dirfd, name, 0);
  int fd = openat(store->dirfd, name,
                  O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) {
    return BWV_E_IO;
  }
  int ok = fchmod(fd, 0600) == 0; /* whatever the umask */
  size_t done = 0;
  while (ok && done < len) {
    ssize_t n = write(fd, data + done, len - done);
    if (n < 0 && errno == EINTR) {
      continue;
    }
    ok = n > 0;
    if (ok) {
      done += (size_t)n;
    }
  }
  ok = ok && fsync(fd) == 0;
  ok = close(fd) == 0 && ok;
  if (!ok) {
    unlinkat(store->dirfd, name, 0);
    return BWV_E_IO;
  }
  return BWV_OK;
}

bwv_status bws_rename(bws_store* store, const char* from, const char* to) {
  if (renameat(store->dirfd, from, store->dirfd, to) != 0) {
    return BWV_E_IO;
  }
  return fsync(store->dirfd) == 0 ? BWV_OK : BWV_E_IO;
}

bwv_status bws_replace(bws_store* store, const char* name, const uint8_t* data,
                       size_t len) {
  char tmp[MAX_NAME + sizeof(TMP_SUFFIX)];
  if (!tmp_name_of(name, tmp)) {
    return BWV_E_ARG;
  }
  bwv_status status = write_new_file(store, tmp, data, len);
  if (status == BWV_OK) {
    status = bws_rename(store, tmp, name);
    if (status != BWV_OK) {
      unlinkat(store->dirfd, tmp, 0);
    }
  }
  return status;
}

bwv_status bws_remove(bws_store* store, const char* name) {
  if (unlinkat(store->dirfd, name, 0) != 0) {
    return errno == ENOENT ? BWV_OK : BWV_E_IO;
  }
  return fsync(store->dirfd) == 0 ? BWV_OK : BWV_E_IO;
}

/* Tighten a file found looser than 0600. */
static bwv_status tighten(bws_store* store, const char* name, int* fixed) {
  int fd = openat(store->dirfd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    return errno == ENOENT ? BWV_OK : BWV_E_IO;
  }
  struct stat st;
  bwv_status status = BWV_OK;
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_uid != geteuid()) {
    status = BWV_E_IO;
  } else if (st.st_mode & 077) {
    status = fchmod(fd, 0600) == 0 ? BWV_OK : BWV_E_IO;
    *fixed = 1;
  }
  close(fd);
  return status;
}

bwv_status bws_open(const char* dir, bws_store** out, int* perms_fixed) {
  *perms_fixed = 0;
  bws_store* store = (bws_store*)calloc(1, sizeof(*store));
  if (!store) {
    return BWV_E_NOMEM;
  }
  store->dirfd = store->lockfd = -1;
  if (mkdir(dir, 0700) != 0 && errno != EEXIST) {
    close_store(store);
    return BWV_E_IO;
  }
  /* O_NOFOLLOW: a symlink in the directory's place is refused. */
  store->dirfd = open(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat st;
  if (store->dirfd < 0 || fstat(store->dirfd, &st) != 0 ||
      st.st_uid != geteuid()) {
    close_store(store);
    return BWV_E_IO;
  }
  if (st.st_mode & 077) {
    if (fchmod(store->dirfd, 0700) != 0) {
      close_store(store);
      return BWV_E_IO;
    }
    *perms_fixed = 1;
  }
  store->lockfd = openat(store->dirfd, LOCK_NAME,
                         O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (store->lockfd < 0) {
    close_store(store);
    return BWV_E_IO;
  }
  if (flock(store->lockfd, LOCK_EX | LOCK_NB) != 0) {
    bwv_status status = errno == EWOULDBLOCK ? BWV_E_IN_USE : BWV_E_IO;
    close_store(store);
    return status;
  }
  /* What a crash may have left; never promoted. */
  const char* leftovers[] = {BWS_STAGED, BWS_VAULT TMP_SUFFIX,
                             BWS_BACKUP TMP_SUFFIX, BWS_STAGED TMP_SUFFIX,
                             BWS_CLEANUP_MARKER TMP_SUFFIX};
  for (size_t i = 0; i < sizeof(leftovers) / sizeof(leftovers[0]); i++) {
    if (bws_remove(store, leftovers[i]) != BWV_OK) {
      close_store(store);
      return BWV_E_IO;
    }
  }
  if (tighten(store, BWS_VAULT, perms_fixed) != BWV_OK ||
      tighten(store, BWS_BACKUP, perms_fixed) != BWV_OK ||
      tighten(store, LOCK_NAME, perms_fixed) != BWV_OK) {
    close_store(store);
    return BWV_E_IO;
  }
  *out = store;
  return BWV_OK;
}

#endif
