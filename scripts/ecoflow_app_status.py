#!/usr/bin/env python3
"""Read EcoFlow app device status through the private app API.

Required environment variables:
  ECOFLOW_EMAIL
  ECOFLOW_PASSWORD

Optional:
  ECOFLOW_APP_HOST=api-s.ecoflow.com
  ECOFLOW_SN=R631...   # print only this device

This script prints no passwords, bearer tokens, signatures, or full serials.
The endpoint was observed in an iOS EcoFlow app HAR capture. It may require
additional private app signing headers that are not part of the public API.
"""

import base64
import getpass
import json
import os
import secrets
import string
import time
import uuid
import urllib.error
import urllib.request


HOST = os.environ.get("ECOFLOW_APP_HOST", "api-s.ecoflow.com")
EMAIL = os.environ.get("ECOFLOW_EMAIL") or input("EcoFlow email: ").strip()
PASSWORD = os.environ.get("ECOFLOW_PASSWORD") or getpass.getpass("EcoFlow password: ")


def request_json(path, *, method="GET", body=None, headers=None):
    payload = None
    request_headers = {"Accept": "application/json", "Content-Type": "application/json"}
    request_headers.update(headers or {})
    if body is not None:
        payload = json.dumps(body).encode("utf-8")

    request = urllib.request.Request(
        f"https://{HOST}{path}",
        data=payload,
        headers=request_headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"code": str(error.code), "message": raw[:200]}


login = request_json(
    "/auth/login",
    method="POST",
    body={
        "email": EMAIL,
        "password": base64.b64encode(PASSWORD.encode("utf-8")).decode("ascii"),
        "scene": "IOT_APP",
        "userType": "ECOFLOW",
    },
    headers={"lang": "en_US"},
)

if str(login.get("message", "")).lower() != "success":
    print(json.dumps({"stage": "login", "code": login.get("code"), "message": login.get("message")}, indent=2))
    raise SystemExit(1)

token = ((login.get("data") or {}).get("token"))
if not token:
    print('{"stage": "login", "message": "login response did not contain a token"}')
    raise SystemExit(1)

# These are the non-secret app-style headers visible in the iOS HAR.
# X-Sign is intentionally omitted until its private algorithm is identified.
nonce = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(8))
timestamp_ms = str(int(time.time() * 1000))
app_timestamp = time.strftime("%Y%m%d%H%M%S", time.localtime())
app_headers = {
    "Authorization": f"Bearer {token}",
    "X-Nonce": nonce,
    "X-Timestamp": timestamp_ms,
    "X-Appid": "-1",
    "timestamp": app_timestamp,
    "lang": "en-us",
    "did": str(uuid.uuid4()).upper(),
    "dtype": "2",
    "vcode": "86",
    "systemName": "user_app",
    "version": "6.18.0",
    "countryCode": "MY",
    "fromType": "device_list_home",
    "platform": "ios",
    "productId": "1000",
}

status = request_json("/iot-devices/user/device/v3", headers=app_headers)
if str(status.get("message", "")).lower() != "success":
    print(json.dumps({"stage": "device-status", "code": status.get("code"), "message": status.get("message")}, indent=2))
    raise SystemExit(2)

bound = ((status.get("data") or {}).get("bound") or {})
requested_sn = os.environ.get("ECOFLOW_SN", "").strip().upper()
results = []
for serial, device in bound.items():
    if requested_sn and serial.upper() != requested_sn:
        continue
    results.append(
        {
            "serialSuffix": serial[-4:],
            "deviceName": device.get("deviceName"),
            "model": device.get("model"),
            "productType": device.get("productType"),
            "online": device.get("online"),
            "soc": device.get("soc"),
            "chargeStatus": device.get("chargeStatus"),
        }
    )

print(json.dumps({"code": status.get("code"), "devices": results}, indent=2))
