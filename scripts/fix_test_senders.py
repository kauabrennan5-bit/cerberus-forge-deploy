import re

path = "tests/shopeeCommand.test.ts"
lines = open(path).read().split("\n")

# Pattern of the broken body (7 lines) inside arrow-function mock bodies:
broken = [
    "        capturedPhoto = { chatId, photoUrl, caption, markup };",
    "        return { ok: true };",
    "      ",
    "        capturedPhoto = { chatId, photoUrl, caption, markup };",
    "        return { ok: true };",
    "      };",
]
fixed = [
    "        capturedPhoto = { chatId, photoUrl, caption, markup };",
    "        return { ok: true };",
    "      };",
]

count = 0
out = []
i = 0
while i < len(lines):
    if lines[i:i + len(broken)] == broken:
        out.extend(fixed)
        i += len(broken)
        count += 1
    else:
        out.append(lines[i])
        i += 1

open(path, "w").write("\n".join(out))
print("fixed blocks:", count)
