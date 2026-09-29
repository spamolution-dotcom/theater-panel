# Builds the teaser URL's ?d= value. The words stay in HA (the automation's load_url), never in this repo.
import base64, json
words = {
  "name": "<Name>", "credit": "A <names> Production",
  "tagline": "One night only. A story about the best person we know.",
  "meta": [["Released", "<D Month YYYY>"], ["Rated", "U · Universally loved"], ["Screening", "Cinema room"]],
  "after": "Head to the cinema room.", "posterPos": "50% 30%",
}
d = base64.urlsafe_b64encode(json.dumps(words, ensure_ascii=False, separators=(',', ':')).encode()).decode().rstrip('=')
print(f"http://192.168.107.55:8787/birthday?d={d}")
