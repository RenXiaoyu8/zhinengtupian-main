#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
尚品易站云资产 - 轻量更新程序
用法:
  exe: updater.exe --current-exe "C:\...\尚品易站云资产.exe" --url "http://server/releases/app-1.0.1.exe" [--restart]
  zip: updater.exe --current-exe "C:\...\尚品易站云资产.exe" --url "http://server/releases/shangpin-1.0.1.zip" [--restart]
zip 时：下载 zip -> 解压到临时目录 -> 将解压内容覆盖到 exe 所在目录 -> 可选重启
"""
import argparse
import os
import sys
import time
import shutil
import urllib.request
import subprocess
import zipfile
import tempfile
import math

RETRY_SECONDS = 30


def make_logger(log_path):
    """简单日志函数：同时打印到控制台并写入文件。"""
    def _log(*args):
        msg = " ".join(str(a) for a in args)
        try:
            print(msg, flush=True)
        except Exception:
            pass
        try:
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(msg + "\n")
        except Exception:
            pass
    return _log


def render_progress(downloaded, total):
    if not total:
        return f"已下载 {downloaded // 1024} KB"
    pct = min(100, int(downloaded * 100 / total))
    filled = max(0, min(30, math.floor(pct / 100 * 30)))
    bar = "█" * filled + "░" * (30 - filled)
    return f"[{bar}] {pct:3d}%  {downloaded // 1024} KB / {total // 1024} KB"


def download_file(url, dest, log=None):
    req = urllib.request.Request(url, headers={'User-Agent': 'ShangpinUpdater/1.0'})
    with urllib.request.urlopen(req, timeout=300) as resp:
        total = resp.headers.get('Content-Length')
        total = int(total) if total else None
        downloaded = 0
        last_pct = -1
        last_report_at = time.time()
        if log:
          log('下载进度:')
          log('  ' + render_progress(0, total))
        with open(dest, 'wb') as f:
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)
                if log:
                    pct = int(downloaded * 100 / total) if total else -1
                    now = time.time()
                    if (total and pct != last_pct and (pct % 5 == 0 or pct == 100)) or (not total and now - last_report_at >= 2):
                        log('  ' + render_progress(downloaded, total))
                        last_pct = pct
                        last_report_at = now
        if log:
            log('  ' + render_progress(downloaded, total))
            log('下载完成。')


def retry_file_op(fn, log, desc):
    last_err = None
    for _ in range(RETRY_SECONDS):
        try:
            return fn()
        except Exception as e:
            last_err = e
            time.sleep(1)
    log(desc, '失败:', last_err)
    raise last_err


def same_path(a, b):
    try:
        return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))
    except Exception:
        return False


def wait_for_main_process_exit(current_exe, exe_name, log):
    log('等待主程序彻底退出...')
    time.sleep(2)
    if os.name != 'nt':
        return

    def is_running():
        try:
            result = subprocess.run(
                ['tasklist', '/FI', f'IMAGENAME eq {exe_name}'],
                capture_output=True,
                text=True,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
            return exe_name.lower() in (result.stdout or '').lower()
        except Exception:
            return False

    for _ in range(15):
        if not is_running():
            return
        time.sleep(1)

    log('主程序仍未退出，尝试强制关闭...', exe_name)
    try:
        subprocess.run(
            ['taskkill', '/F', '/T', '/IM', exe_name],
            capture_output=True,
            text=True,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
    except Exception as e:
        log('强制关闭主程序失败:', e)
    time.sleep(2)


def copy_entry(src, dst, current_updater_path, log):
    if os.path.isdir(src):
        os.makedirs(dst, exist_ok=True)
        for name in os.listdir(src):
            copy_entry(os.path.join(src, name), os.path.join(dst, name), current_updater_path, log)
        return

    if same_path(dst, current_updater_path):
        log('跳过当前运行中的升级器:', dst)
        return

    parent = os.path.dirname(dst)
    if parent and not os.path.exists(parent):
        os.makedirs(parent, exist_ok=True)

    if os.path.isdir(dst):
        retry_file_op(lambda d=dst: shutil.rmtree(d, ignore_errors=False), log, '删除旧目录 ' + dst)

    retry_file_op(lambda s=src, d=dst: shutil.copy2(s, d), log, '复制文件 ' + os.path.basename(dst))


def update_from_zip(download_url, dir_name, current_exe, restart, log):
    log('=' * 60)
    log('  正在升级中，请勿关闭窗口')
    log('  下载完成后将自动完成升级并重新打开软件，请耐心等待...')
    log('=' * 60)
    log('')
    log('正在下载新版本 (zip)...', download_url)
    tmp_dir = tempfile.mkdtemp(prefix='shangpin_update_')
    zip_path = os.path.join(tmp_dir, 'update.zip')
    try:
        download_file(download_url, zip_path, log)
    except Exception as e:
        log('下载失败:', e)
        log('>>> 升级失败，请检查网络后重试。<<<')
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return 1

    log('下载完成，正在解压...')
    extract_dir = os.path.join(tmp_dir, 'extract')
    os.mkdir(extract_dir)
    try:
        with zipfile.ZipFile(zip_path, 'r') as z:
            z.extractall(extract_dir)
    except Exception as e:
        log('解压失败:', e)
        log('>>> 升级失败，请重新下载后重试。<<<')
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return 1

    # 解压后可能有一层子目录（例如 win-unpacked 或 尚品易站云资产-1.0.1）
    root = extract_dir
    items = os.listdir(extract_dir)
    if len(items) == 1 and os.path.isdir(os.path.join(extract_dir, items[0])):
        root = os.path.join(extract_dir, items[0])

    log('正在覆盖安装目录...', 'root =', root, 'dir_name =', dir_name)
    log('(此步骤可能需要 10-30 秒，请勿关闭窗口)')
    current_updater_path = os.path.abspath(sys.executable) if getattr(sys, 'frozen', False) else os.path.abspath(__file__)

    fail_count = 0
    fail_items = []
    for name in os.listdir(root):
        src = os.path.join(root, name)
        dst = os.path.join(dir_name, name)
        try:
            log(f'  处理: {name}')
            copy_entry(src, dst, current_updater_path, log)
        except Exception as e:
            fail_count += 1
            fail_items.append(name)
            log(f'  [失败] 复制 {name}: {e}')

    shutil.rmtree(tmp_dir, ignore_errors=True)

    if fail_count > 0:
        log('')
        log(f'警告：有 {fail_count} 个文件/目录复制失败: {", ".join(fail_items)}')
        log('升级可能不完整，建议重新运行软件后再次尝试升级。')
    else:
        log('')
        log('所有文件复制完成。')

    if fail_count == 0:
        log('升级完成！')
    else:
        log('升级未完成。')

    if restart and fail_count == 0:
        log('')
        log('正在启动主程序...', current_exe)
        log('(启动后此窗口将自动关闭)')
        time.sleep(1)
        subprocess.Popen([current_exe], cwd=dir_name, shell=False, close_fds=True)

    return 0 if fail_count == 0 else 1


def update_from_exe(download_url, dir_name, current_exe, exe_name, name_no_ext, restart, log):
    log('=' * 60)
    log('  正在升级中，请勿关闭窗口')
    log('  下载完成后将自动完成升级并重新打开软件，请耐心等待...')
    log('=' * 60)
    log('')

    new_file = os.path.join(dir_name, name_no_ext + '_new.exe')
    old_backup = os.path.join(dir_name, name_no_ext + '_old.exe')
    log('正在下载新版本 (exe)...', download_url)
    try:
        download_file(download_url, new_file, log)
    except Exception as e:
        log('下载失败:', e)
        log('>>> 升级失败，请检查网络后重试。<<<')
        return 1

    if not os.path.isfile(new_file):
        log('下载后未找到文件:', new_file)
        log('>>> 升级失败。<<<')
        return 1

    log('替换旧版本...', 'current_exe =', current_exe)
    try:
        if os.path.isfile(old_backup):
            try:
                os.remove(old_backup)
            except OSError:
                pass
        retry_file_op(lambda: os.rename(current_exe, old_backup), log, '备份旧 exe')
        retry_file_op(lambda: shutil.move(new_file, current_exe), log, '替换新 exe')
    except Exception as e:
        log('替换失败:', e)
        log('>>> 升级失败，程序文件可能被占用，请关闭软件后重试。<<<')
        if os.path.isfile(new_file):
            try:
                os.remove(new_file)
            except OSError:
                pass
        return 1

    try:
        os.remove(old_backup)
    except OSError:
        pass

    log('')
    log('升级完成！')
    if restart:
        log('')
        log('正在启动主程序...', current_exe)
        log('(启动后此窗口将自动关闭)')
        time.sleep(1)
        subprocess.Popen([current_exe], cwd=dir_name, shell=False, close_fds=True)
    return 0


def main():
    parser = argparse.ArgumentParser(description='尚品易站云资产 更新程序')
    parser.add_argument('--current-exe', required=True, help='当前主程序 exe 完整路径')
    parser.add_argument('--url', required=True, help='新版本下载地址 (.exe 或 .zip)')
    parser.add_argument('--restart', action='store_true', help='更新完成后启动主程序')
    args = parser.parse_args()

    current_exe = os.path.abspath(args.current_exe)
    download_url = args.url.strip()
    dir_name = os.path.dirname(current_exe)
    exe_name = os.path.basename(current_exe)
    name_no_ext, _ = os.path.splitext(exe_name)

    log_path = os.path.join(dir_name, "updater.log")
    log = make_logger(log_path)
    log("==== 启动更新程序 ====")
    log("current_exe =", current_exe)
    log("download_url =", download_url)

    if not os.path.isfile(current_exe):
        log('错误: 找不到当前程序', current_exe)
        sys.exit(1)

    wait_for_main_process_exit(current_exe, exe_name, log)

    if download_url.lower().endswith('.zip'):
        code = update_from_zip(download_url, dir_name, current_exe, args.restart, log)
    else:
        code = update_from_exe(download_url, dir_name, current_exe, exe_name, name_no_ext, args.restart, log)

    if code != 0:
        log('')
        log('升级未能完成。请将此窗口截图发给管理员，或查看 updater.log 了解详情。')
        log('按 Enter 键关闭窗口...')
        try:
            input()
        except Exception:
            time.sleep(10)
    else:
        log('')
        log('升级流程结束，窗口即将关闭。')
        time.sleep(1)

    sys.exit(code)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        # 若发生未捕获异常，也写入日志方便排查
        try:
            dir_name = os.path.dirname(os.path.abspath(sys.argv[0]))
            log_path = os.path.join(dir_name, "updater_fatal.log")
            with open(log_path, "a", encoding="utf-8") as f:
                f.write("FATAL: %s\n" % e)
        except Exception:
            pass
        try:
            print(f"\n[严重错误] {e}\n升级失败，请截图发给管理员。")
            input("按 Enter 键关闭...")
        except Exception:
            pass
        raise
