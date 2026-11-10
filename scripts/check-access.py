#!/usr/bin/env python3
"""Check credential capabilities without printing credentials or response bodies."""
import json
import os
import re
import sys
import urllib.error
import urllib.request


def request(origin, path, token):
    req = urllib.request.Request(
        origin + path,
        headers={"Authorization": "Bearer " + token, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError("HTTP " + str(error.code)) from None
    except (urllib.error.URLError, TimeoutError, ValueError):
        raise RuntimeError("network failure or invalid response") from None


def required(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError("Missing " + name)
    return value


def cloudflare():
    account = required("CLOUDFLARE_ACCOUNT_ID")
    if not re.fullmatch(r"[a-fA-F0-9]{32}", account):
        raise RuntimeError("CLOUDFLARE_ACCOUNT_ID must be a 32-character account ID")
    token = required("CLOUDFLARE_API_TOKEN")
    base = "/client/v4/accounts/" + account
    for label, path in [
        ("Account access", base),
        ("Workers API", base + "/workers/scripts"),
        ("R2 API", base + "/r2/buckets"),
        ("Workers AI model catalog", base + "/ai/models/search?per_page=1"),
    ]:
        try:
            result = request("https://api.cloudflare.com", path, token)
            if result.get("success") is not True:
                raise RuntimeError("API rejected access")
        except RuntimeError as error:
            raise RuntimeError(label + ": " + str(error)) from None
        print(label + ": verified")
    print("Write/deploy permissions will be verified by the actual deployment.")


def npm():
    token = required("NPM_TOKEN")
    scope = required("NPM_SCOPE").lstrip("@")
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*", scope):
        raise RuntimeError("NPM_SCOPE must be an npm username or organization name")
    result = request("https://registry.npmjs.org", "/-/whoami", token)
    username = result.get("username")
    if not isinstance(username, str) or not username:
        raise RuntimeError("npm did not authenticate the token")
    # Publication-scoped tokens need no organization-management permission.
    # Do not request membership APIs that such a token cannot necessarily read.
    print("npm authentication: verified; publication scope configured")
    print("Publication rights and new-package creation remain unverified until publish.")


if __name__ == "__main__":
    try:
        {"cloudflare": cloudflare, "npm": npm}[sys.argv[1]]()
    except (RuntimeError, KeyError, IndexError) as error:
        print("Access preflight failed: " + str(error), file=sys.stderr)
        sys.exit(1)
