"""
One-time helper: get an OAuth refresh token for the NetComix harvester.

Usage:
    1. In Google Cloud Console, create an OAuth 2.0 Client ID (Desktop app).
       APIs & Services → Credentials → + Create Credentials → OAuth client ID
       → Application type: Desktop app → Name: NetComix harvester → Create.
       Download the JSON or copy the client_id + client_secret.

    2. Add yourself as a Test User on the OAuth consent screen:
       APIs & Services → OAuth consent screen → Test users → + Add users
       → enter your Gmail. (Skip if app is in "Production" status.)

    3. Run this script:
           pip install google-auth-oauthlib
           python harvester/get_refresh_token.py <client_id> <client_secret>
       A browser window opens. Sign in, click Allow.
       The script prints your refresh token — store it as a GitHub secret.

    4. In your repo, add these three secrets (Settings → Secrets and variables → Actions):
           GOOGLE_OAUTH_CLIENT_ID       = <the client id>
           GOOGLE_OAUTH_CLIENT_SECRET   = <the client secret>
           GOOGLE_OAUTH_REFRESH_TOKEN   = <token printed below>
       You can delete the old GOOGLE_SERVICE_ACCOUNT_JSON secret.
"""

from __future__ import annotations

import sys

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/drive"]


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: python get_refresh_token.py <client_id> <client_secret>")
        return 2
    client_id, client_secret = sys.argv[1], sys.argv[2]
    flow = InstalledAppFlow.from_client_config(
        {
            "installed": {
                "client_id": client_id,
                "client_secret": client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": ["http://localhost"],
            }
        },
        scopes=SCOPES,
    )
    creds = flow.run_local_server(port=0, prompt="consent", access_type="offline")
    if not creds.refresh_token:
        print("ERROR: no refresh_token returned. Re-run — make sure you click Allow on a fresh consent screen.")
        return 1
    print()
    print("=" * 70)
    print("SUCCESS. Copy the refresh token below into a GitHub secret named")
    print("GOOGLE_OAUTH_REFRESH_TOKEN (and add the client id/secret as their")
    print("own secrets too):")
    print("=" * 70)
    print(creds.refresh_token)
    print("=" * 70)
    return 0


if __name__ == "__main__":
    sys.exit(main())
