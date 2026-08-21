import re

path = "tests/shopeeCommand.test.ts"
src = open(path).read()

pattern = re.compile(
    r'Object\.defineProperty\(telegramModule, "(sendTelegramMessage|sendTelegramPhoto)", \{\s*value: '
)

def replace_all(text):
    out = []
    pos = 0
    for m in pattern.finditer(text):
        fn = m.group(1)
        body_start = m.end()
        # Find the body (balanced braces) starting at body_start
        depth = 0
        i = body_start
        in_str = None
        while i < len(text):
            ch = text[i]
            if in_str:
                if ch == in_str and text[i-1] != '\\':
                    in_str = None
            elif ch in ('"', "'", '`'):
                in_str = ch
            elif ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    break
            i += 1
        body = text[body_start:i+1]
        out.append(text[pos:m.start()])
        out.append(f'(telegramModule as any).{fn} = {body};')
        pos = i + 1
    out.append(text[pos:])
    return ''.join(out)

src = replace_all(src)
open(path, 'w').write(src)
print("sendTelegramMessage =", src.count('(telegramModule as any).sendTelegramMessage ='))
print("sendTelegramPhoto =", src.count('(telegramModule as any).sendTelegramPhoto ='))
