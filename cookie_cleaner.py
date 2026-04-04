with open("cookies_raw.txt", "r") as f:
    content = f.read()

# Remove line breaks and normalize spacing
single_line = " ".join(content.split())

with open("cookies.txt", "w") as f:
    f.write(single_line)

print("Cookies formatted successfully.")
