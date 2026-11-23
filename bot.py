import json
import os
import time
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import urllib.parse
import base64
import hmac
import hashlib
from pathlib import Path
from urllib.parse import urlparse


TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
API = f"https://api.telegram.org/bot{TOKEN}" if TOKEN else None
PORT = int(os.environ.get("PORT", "3000"))


def normalize_web_app_url(value):
    value = value.strip()
    if "://" not in value:
        value = f"https://{value}"
    parsed_url = urlparse(value)
    if parsed_url.scheme != "https" or not parsed_url.netloc:
        raise ValueError("WEB_APP_URL должен быть корректным HTTPS-адресом")
    return value


WEB_APP_URL = normalize_web_app_url(os.environ.get(
    "WEB_APP_URL",
    "https://thirty-worlds-go.loca.lt",
))
ADMIN_USER_IDS = frozenset({"8414885700", "6627701692", "1987944272"})
DATA_DIR = Path(os.environ.get(
    "RAILWAY_VOLUME_MOUNT_PATH",
    str(Path(__file__).parent),
))
DATA_FILE = DATA_DIR / "products.json"
UPLOADS_DIR = DATA_DIR / "uploads"
DATA_DIR.mkdir(exist_ok=True)
UPLOADS_DIR.mkdir(exist_ok=True)


def load_products():
    if not DATA_FILE.exists():
        return []
    try:
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []


def save_products(products):
    DATA_FILE.write_text(json.dumps(products, ensure_ascii=False), encoding="utf-8")


def verify_admin(init_data):
    if not TOKEN or not init_data:
        return False
    try:
        pairs = dict(urllib.parse.parse_qsl(init_data, keep_blank_values=True))
        received_hash = pairs.pop("hash", "")
        data_check_string = "\n".join(
            f"{key}={pairs[key]}" for key in sorted(pairs)
        )
        secret_key = hmac.new(
            b"WebAppData",
            TOKEN.encode(),
            hashlib.sha256,
        ).digest()
        expected_hash = hmac.new(
            secret_key,
            data_check_string.encode(),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(received_hash, expected_hash):
            return False
        user = json.loads(pairs["user"])
        return str(user.get("id")) in ADMIN_USER_IDS
    except (KeyError, json.JSONDecodeError, ValueError):
        return False


def telegram(method, payload=None):
    if not API:
        return None
    data = json.dumps(payload).encode() if payload else None
    request = urllib.request.Request(
        f"{API}/{method}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST" if data else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        try:
            response_body = json.loads(error.read().decode())
            description = response_body.get("description", "неизвестная ошибка")
        except (json.JSONDecodeError, UnicodeDecodeError):
            description = "Telegram не принял запрос"
        raise RuntimeError(
            f"Telegram API {method}: HTTP {error.code}: {description}"
        ) from error


def send_message(chat_id, text):
    return telegram("sendMessage", {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
    })


def send_start_message(chat_id):
    return telegram("sendMessage", {
        "chat_id": chat_id,
        "text": (
            "👋 Добро пожаловать в AXE STORE\n"
            "- Брендовая одежда, обувь, сумки и аксессуары в наличии.\n"
            "- Весь каталог открывается кнопкой «Магазин» ниже.\n\n"
            "✉️ Связь и покупка: @chkenfs"
        ),
        "reply_markup": {
            "inline_keyboard": [[{
                "text": "Магазин",
                "web_app": {"url": WEB_APP_URL},
            }, {
                "text": "Выкуп и услуги",
                "url": "https://t.me/chkenfs",
            }]],
        },
    })


def polling_loop():
    if not API:
        print("TELEGRAM_BOT_TOKEN не задан")
        return
    offset = 0
    while True:
        try:
            result = telegram("getUpdates", {
                "offset": offset,
                "timeout": 30,
                "allowed_updates": ["message"],
            })
            for update in result.get("result", []):
                offset = update["update_id"] + 1
                message = update.get("message") or {}
                chat_id = message.get("chat", {}).get("id")
                web_app_data = message.get("web_app_data")
                if web_app_data:
                    try:
                        order = json.loads(web_app_data["data"])
                        lines = [
                            f"<b>{item['name']}</b> × {item['quantity']} — "
                            f"{item['price'] * item['quantity']} ₽"
                            for item in order["items"]
                        ]
                        send_message(
                            chat_id,
                            "Новый заказ:\n" + "\n".join(lines)
                            + f"\n\nИтого: <b>{order['total']} ₽</b>",
                        )
                    except (json.JSONDecodeError, KeyError, TypeError):
                        send_message(chat_id, "Не удалось обработать заказ.")
                elif chat_id:
                    if message.get("text") in ("/start", "/start@Axe_store_bot"):
                        send_start_message(chat_id)
                    else:
                        send_message(
                            chat_id,
                            "Нажмите кнопку «Магазин» ниже, чтобы открыть каталог.",
                        )
        except Exception as error:
            print("Polling error:", error)
        time.sleep(1)


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        parsed_path = urllib.parse.unquote(urlparse(path).path)
        if parsed_path.startswith("/uploads/"):
            return str(UPLOADS_DIR / Path(parsed_path).name)
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == "/api/products":
            self.send_json(200, {"products": load_products()})
            return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ("/api/products", "/api/upload"):
            self.send_json(404, {"error": "Not found"})
            return

        init_data = self.headers.get("X-Telegram-Init-Data", "")
        local_admin = (
            not TOKEN
            and self.headers.get("X-Admin-User-Id") in ADMIN_USER_IDS
        )
        if not local_admin and not verify_admin(init_data):
            self.send_json(403, {"error": "Доступ запрещён"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            self.send_json(400, {"error": "Некорректные данные"})
            return

        products = load_products()
        if path == "/api/products":
            if body.get("action") == "delete":
                product_id = str(body["id"])
                products = [item for item in products if str(item["id"]) != product_id]
            else:
                products.insert(0, body["product"])
            save_products(products)
            self.send_json(200, {"products": products})
            return

        image = body.get("image", "")
        if not image.startswith("data:image/"):
            self.send_json(400, {"error": "Некорректное изображение"})
            return
        header, encoded = image.split(",", 1)
        extension = "png" if "png" in header else "jpg"
        name = f"{int(time.time() * 1000)}.{extension}"
        (UPLOADS_DIR / name).write_bytes(base64.b64decode(encoded))
        self.send_json(200, {"url": f"/uploads/{name}"})


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    Thread(target=polling_loop, daemon=True).start()
    print(f"AXE STORE server: http://0.0.0.0:{PORT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
