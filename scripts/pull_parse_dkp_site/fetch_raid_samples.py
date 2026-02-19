"""Fetch past raids page and one raid details page to inspect HTML."""
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
    "Referer": BASE + "/",
}
s = requests.Session()
s.headers.update(headers)
for k, v in cookies.items():
    s.cookies.set(k, v)

# Past raids list
url_list = BASE + "/rapid_raid/raids.php?mode=past&gid=547766&ts=3:1"
r1 = s.get(url_list, timeout=30)
Path("sample_past_raids.html").write_text(r1.text, encoding="utf-8")
print("Saved sample_past_raids.html")

# One raid details
url_detail = BASE + "/rapid_raid/raid_details.php?raid_pool=562569&raidId=1598641&gid=547766"
r2 = s.get(url_detail, timeout=30)
Path("sample_raid_details.html").write_text(r2.text, encoding="utf-8")
print("Saved sample_raid_details.html")

# Show links that look like raid_details
from bs4 import BeautifulSoup
soup = BeautifulSoup(r1.text, "lxml")
for a in soup.find_all("a", href=True):
    href = a.get("href", "")
    if "raid_details" in href or "raidId=" in href:
        print(href[:120], "|", a.get_text(strip=True)[:40])
