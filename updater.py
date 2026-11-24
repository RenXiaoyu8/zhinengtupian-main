#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""下载便携版，等待旧客户端退出，替换文件并按需重新启动。"""
import argparse
import ctypes
import filecmp
import os
from pathlib import Path
from queue import Empty, SimpleQueue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile
from urllib.parse import urlsplit


class LanRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        def origin(url):
            parts = urlsplit(url)
            return parts.scheme, parts.hostname, parts.port or (443 if parts.scheme == 'https' else 80)
        if origin(req.full_url) != origin(newurl):
            raise OSError('局域网更新地址跳转到了其他服务器，请检查更新包地址')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url, dest, log, lan_only=False):
    request = urllib.request.Request(url, headers={'User-Agent': 'ShangpinUpdater/1.0'})
    open_url = urllib.request.urlopen
    if lan_only:
        open_url = urllib.request.build_opener(urllib.request.ProxyHandler({}), LanRedirectHandler()).open
    with open_url(request, timeout=300) as response, dest.open('wb') as output:
        total = int(response.headers.get('Content-Length', 0))
        received = 0
        next_report = 0
        while chunk := response.read(256 * 1024):
            output.write(chunk)
            received += len(chunk)
            if time.monotonic() >= next_report:
                percent = f'（{received * 100 // total}%）' if total else ''
                log(f'正在下载新版，已接收 {received // 1024} KB{percent}')
                next_report = time.monotonic() + 1
        if total and received != total:
            raise OSError('下载的文件不完整，请重试')


def wait_for_client(pid, log):
    if os.name != 'nt' or not pid:
        # 旧版客户端没有传入 PID，文件替换时仍会检查占用。
        return
    import _winapi
    try:
        handle = _winapi.OpenProcess(_winapi.SYNCHRONIZE, False, pid)
    except OSError as exc:
        if exc.winerror == 87:  # 主进程已退出
            return
        raise
    try:
        log('正在等待旧版云资产退出…')
        if _winapi.WaitForSingleObject(handle, 30000) == _winapi.WAIT_TIMEOUT:
            raise OSError('旧版客户端仍在运行，请完全退出后重试')
    finally:
        _winapi.CloseHandle(handle)


def move_when_available(src, dst, log):
    deadline = time.monotonic() + 30
    while True:
        try:
            os.replace(src, dst)
            return
        except PermissionError as exc:
            if time.monotonic() >= deadline:
                raise OSError(f'无法替换 {src.name}，请检查文件是否被占用或目录是否可写') from exc
            log(f'正在等待文件解除占用：{src.name}')
            time.sleep(1)


def install(staged, target, backup, log):
    entries = list(staged.rglob('*'))
    files = [p for p in entries if p.is_file()]
    journal = []
    created_dirs = []
    next_report = 0
    try:
        for directory in sorted(p for p in entries if p.is_dir()):
            dest = target / directory.relative_to(staged)
            if not dest.is_dir():
                dest.mkdir()
                created_dirs.append(dest)
        for index, src in enumerate(files, 1):
            relative = src.relative_to(staged)
            dest = target / relative
            if time.monotonic() >= next_report or index == len(files):
                log(f'正在安装 {index}/{len(files)}：{relative}')
                next_report = time.monotonic() + 0.5
            if dest.is_dir():
                raise OSError(f'同名目录阻止安装：{dest}')
            saved = None
            if dest.exists():
                # 旧启动器可能直接运行安装目录中的 updater.exe。
                if getattr(sys, 'frozen', False) and os.path.samefile(dest, sys.executable):
                    continue
                saved = backup / relative
                saved.parent.mkdir(parents=True, exist_ok=True)
                try:
                    os.replace(dest, saved)
                except PermissionError:
                    if filecmp.cmp(src, dest, shallow=False):
                        continue
                    move_when_available(dest, saved, log)
            journal.append((dest, saved))
            move_when_available(src, dest, log)
    except Exception:
        log('安装中断，正在恢复旧版本…')
        try:
            for dest, saved in reversed(journal):
                if saved is None:
                    dest.unlink(missing_ok=True)
                else:
                    move_when_available(saved, dest, log)
            for directory in reversed(created_dirs):
                directory.rmdir()
        except OSError as exc:
            if backup.exists():
                recovery = target / (backup.parent.name + '-backup')
                backup.rename(recovery)
                raise OSError(f'恢复未完成，旧文件保存在 {recovery}') from exc
            raise
        raise


def install_package(current_exe, url, parent_pid, log, lan_only=False):
    # 在安装盘暂存，替换文件用同卷重命名，也可在失败时恢复原文件。
    with tempfile.TemporaryDirectory(prefix='.shangpin-update-', dir=current_exe.parent,
                                     ignore_cleanup_errors=True) as tmp:
        work = Path(tmp)
        staged = work / 'new'
        staged.mkdir()
        if urlsplit(url).path.lower().endswith('.zip'):
            archive = work / 'download.zip'
            download(url, archive, log, lan_only)
            with zipfile.ZipFile(archive) as package:
                members = package.infolist()
                next_report = 0
                for i, member in enumerate(members, 1):
                    if time.monotonic() >= next_report:
                        log(f'正在解压 {i}/{len(members)}…')
                        next_report = time.monotonic() + 0.5
                    package.extract(member, staged)
            children = list(staged.iterdir())
            if len(children) == 1 and children[0].is_dir():
                staged = children[0]
        else:
            download(url, staged / current_exe.name, log, lan_only)
        if not (staged / current_exe.name).is_file():
            raise ValueError(f'更新包中缺少主程序 {current_exe.name}')
        wait_for_client(parent_pid, log)
        install(staged, current_exe.parent, work / 'backup', log)
        log('文件安装完成，正在清理临时文件…')


def has_visible_window(pid):
    from ctypes import wintypes
    found = False
    enum_proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32 = ctypes.windll.user32
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]

    @enum_proc
    def visit(hwnd, _):
        nonlocal found
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        found = owner.value == pid and bool(user32.IsWindowVisible(hwnd))
        return not found

    user32.EnumWindows(visit, 0)
    return found


def restart_client(exe, log):
    log('新版已安装，正在打开云资产…')
    if os.name == 'nt' and getattr(sys, 'frozen', False):
        ctypes.windll.kernel32.SetDllDirectoryW(None)
    flags = getattr(subprocess, 'DETACHED_PROCESS', 0) | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)
    process = subprocess.Popen([str(exe)], cwd=exe.parent, close_fds=True, creationflags=flags,
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if os.name == 'nt':
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if has_visible_window(process.pid):
                log(f'云资产窗口已打开（PID {process.pid}）')
                return
            if process.poll() is not None:
                raise OSError(f'启动进程已退出，退出码 {process.returncode}')
            time.sleep(0.2)
        raise TimeoutError(f'新版进程已启动（PID {process.pid}），20 秒内尚未看到窗口')


def main():
    parser = argparse.ArgumentParser(description='尚品易站云资产更新程序')
    parser.add_argument('--current-exe', required=True)
    parser.add_argument('--url', required=True)
    parser.add_argument('--restart', action='store_true')
    parser.add_argument('--parent-pid', type=int)
    parser.add_argument('--lan-only', action='store_true')
    args = parser.parse_args()
    exe = Path(args.current_exe).resolve()
    events = SimpleQueue()
    log_file = exe.parent / 'updater.log'

    def log(msg):
        events.put(msg)
        try:
            with log_file.open('a', encoding='utf-8') as output:
                output.write(f'[{time.strftime("%Y-%m-%d %H:%M:%S")}] {msg}\n')
        except OSError:
            pass

    def update():
        try:
            if not exe.is_file():
                raise FileNotFoundError(f'找不到原客户端 {exe}')
            log('正在准备更新…')
            install_package(exe, args.url, args.parent_pid, log, args.lan_only)
        except Exception as exc:
            log(f'更新失败：{exc}\n详情见 {log_file}')
            return 1
        if args.restart:
            try:
                restart_client(exe, log)
            except Exception as exc:
                log(f'新版已安装，自动打开失败：{exc}\n可手动打开 {exe.name}')
                return 2
        return 0

    try:
        import tkinter as tk
        from tkinter import ttk
        root = tk.Tk()
    except Exception:
        return update()

    root.title('尚品易站云资产更新')
    root.resizable(False, False)
    status = tk.StringVar(value='正在准备更新…')
    ttk.Label(root, text='云资产版本更新', font=('Microsoft YaHei UI', 13, 'bold')).pack(anchor='w', padx=20, pady=(16, 6))
    ttk.Label(root, textvariable=status, wraplength=420, width=55).pack(anchor='w', padx=20, pady=(0, 16))
    root.protocol('WM_DELETE_WINDOW', root.iconify)
    result = []

    def work():
        result.append(update())

    thread = threading.Thread(target=work)
    thread.start()

    def refresh():
        finished = not thread.is_alive()
        try:
            while True:
                status.set(events.get_nowait())
        except Empty:
            pass
        if finished:
            root.protocol('WM_DELETE_WINDOW', root.destroy)
            root.after(150 if result == [0] else 12000, root.destroy)
        else:
            root.after(100, refresh)

    refresh()
    root.mainloop()
    thread.join()
    return result[0]


if __name__ == '__main__':
    sys.exit(main())
