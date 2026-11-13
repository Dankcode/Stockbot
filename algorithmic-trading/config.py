"""Alpaca paper-trading credentials, read from the environment.

This folder lives in a public repository: never write a real key into this
file. Export the keys in your shell (or an untracked .env you source) instead:

    export APCA_API_KEY_ID=...
    export APCA_API_SECRET_KEY=...
"""
import os

API_KEY = os.environ.get("APCA_API_KEY_ID", "")
SECRET_KEY = os.environ.get("APCA_API_SECRET_KEY", "")

ALPACA_CONFIG = {
    "API_KEY": API_KEY,
    "API_SECRET": SECRET_KEY,
    # Paper trading endpoint. Changing this to the live endpoint trades real money.
    "ENDPOINT": "https://paper-api.alpaca.markets",
}
