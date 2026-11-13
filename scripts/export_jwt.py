# -*- coding: utf-8 -*-
"""导出 JWT（供 Docker/其他机器部署用）：解密本机 token.json，输出单行 JWT 到 stdout
用法：python scripts/export_jwt.py > data/jwt.txt
"""
import base64
import json
import sys
import io
import os

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.dont_write_bytecode = True

import win32crypt
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

BASE = os.environ.get("TA_DIR", r"D:\TeleAgent\data")

# 找用户目录
users = os.path.join(BASE, "users")
token_path = None
if os.path.isdir(users):
    for d in sorted(os.listdir(users)):
        p = os.path.join(users, d, "app-auth", "token.json")
        if os.path.isfile(p):
            token_path = p
            break
if not token_path:
    p = os.path.join(BASE, "app-auth", "token.json")
    if os.path.isfile(p):
        token_path = p
if not token_path:
    sys.stderr.write("未找到 token.json\n")
    sys.exit(1)

ls = json.load(open(os.path.join(BASE, "Local State"), encoding="utf-8"))
ek = base64.b64decode(ls["os_crypt"]["encrypted_key"])
_, key = win32crypt.CryptUnprotectData(ek[5:], None)

tok = json.load(open(token_path, encoding="utf-8"))
blob = base64.b64decode(tok["encryptedToken"])
if blob[:3] in (b"v10", b"v11"):
    jwt = AESGCM(key).decrypt(blob[3:15], blob[15:], None).decode()
else:
    sys.stderr.write("非预期加密格式\n")
    sys.exit(1)

# 单行输出 JWT 本体（重定向到文件即得到 jwt.txt）
sys.stdout.detach().write(jwt.encode())
