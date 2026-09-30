"""Cloudflare DNS for publicaccess.tv, from the command line.

  python deploy/cfdns.py list
  python deploy/cfdns.py set A foo.publicaccess.tv 199.223.255.101 [--proxied]
  python deploy/cfdns.py delete foo.publicaccess.tv

The API token (Zone:DNS:Edit + Zone:Read on publicaccess.tv) is read from
$CF_TOKEN_FILE, default ~/.config/cloudflare/publicaccess.token. Never commit it.
"""
import json
import os
import sys
import urllib.request

ZONE_NAME = "publicaccess.tv"
API = "https://api.cloudflare.com/client/v4"
TOKEN_FILE = os.environ.get("CF_TOKEN_FILE",
                            os.path.expanduser("~/.config/cloudflare/publicaccess.token"))


def call(method, path, body=None):
    token = open(TOKEN_FILE).read().strip()
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {token}",
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        d = json.load(e)
    if not d.get("success"):
        sys.exit(f"Cloudflare error: {d.get('errors')}")
    return d["result"]


def zone_id():
    return call("GET", f"/zones?name={ZONE_NAME}")[0]["id"]


def records(zid, name=None):
    q = f"?per_page=200" + (f"&name={name}" if name else "")
    return call("GET", f"/zones/{zid}/dns_records{q}")


def main(argv):
    if not argv or argv[0] not in ("list", "set", "delete"):
        sys.exit(__doc__)
    zid = zone_id()
    if argv[0] == "list":
        for r in records(zid):
            print(f"{r['type']:6} {r['name']:45} {r['content'][:50]}{'  (proxied)' if r.get('proxied') else ''}")
    elif argv[0] == "set":
        rtype, name, content = argv[1].upper(), argv[2], argv[3]
        body = {"type": rtype, "name": name, "content": content, "ttl": 1,
                "proxied": "--proxied" in argv}
        existing = [r for r in records(zid, name) if r["type"] == rtype]
        if existing:
            call("PUT", f"/zones/{zid}/dns_records/{existing[0]['id']}", body); print(f"updated {rtype} {name}")
        else:
            call("POST", f"/zones/{zid}/dns_records", body); print(f"created {rtype} {name}")
    else:
        name = argv[1]
        found = records(zid, name)
        if not found:
            sys.exit(f"no records for {name}")
        for r in found:
            call("DELETE", f"/zones/{zid}/dns_records/{r['id']}"); print(f"deleted {r['type']} {name}")


if __name__ == "__main__":
    main(sys.argv[1:])
