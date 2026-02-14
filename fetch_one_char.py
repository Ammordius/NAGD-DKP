"""Fetch one character detail page to inspect HTML for linked toons."""
import requests
from pathlib import Path

BASE = "https://azureguardtakp.gamerlaunch.com"

def parse_cookie_header(cookie_header: str):
    cookies = {}
    for part in cookie_header.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        k, v = part.split("=", 1)
        cookies[k.strip()] = v.strip()
    return cookies

cookie_path = Path("cookies.txt")
cookie_header = cookie_path.read_text(encoding="utf-8").strip()
cookies = parse_cookie_header(cookie_header)

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": "https://azureguardtakp.gamerlaunch.com/",
}
s = requests.Session()
s.headers.update(headers)
for k, v in cookies.items():
    s.cookies.set(k, v)

# First character from roster
url = BASE + "/users/characters/character_detail.php?char=22007284&gid=547766"
r = s.get(url, timeout=30)
Path("sample_character.html").write_text(r.text, encoding="utf-8")
print("Saved sample_character.html")
# Print snippet around likely "linked" text
text = r.text.lower()
for needle in ["linked", "link", "toon", "character", "alt", "account"]:
    idx = text.find(needle)
    if idx != -1:
        snippet = r.text[max(0, idx-80):idx+120]
        print(f"\n--- around '{needle}' ---\n{snippet}\n")
