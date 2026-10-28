# =====================================================================
#  ЯЧЕЙКА 1 — Автоматическая загрузка карт Magellan GxDR с сервера NASA PDS
# =====================================================================
#  Скачиваются 4 глобальные карты в синусоидальной проекции (~200 МБ):
#    GTDR  — радиус планеты (рельеф)                  16 бит
#    GEDR  — микроволновая излучательная способность  16 бит
#    GREDR — отражательная способность Френеля         8 бит
#    GSDR  — RMS-уклон поверхности                     8 бит
#  Файлы кешируются в DATA_DIR: повторный запуск ничего не скачивает.
import requests
from tqdm.auto import tqdm


def local_product_names():
    """Ищет уже скачанные пары .img + .hdr."""
    found = {}
    for key, p in PRODUCTS.items():
        for img in sorted(DATA_DIR.glob(f"{p['prefix']}*.img")):
            if "error" in img.stem.lower():
                continue
            if (DATA_DIR / f"{img.stem}.hdr").exists():
                found[key] = img.stem
                break
    return found


def remote_listing(url):
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    hrefs = re.findall(r'href="([^"]+)"', r.text, flags=re.I)
    return sorted({h.rstrip("/").split("/")[-1] for h in hrefs})


def remote_product_names():
    """Читает листинг каталога на сервере; если не вышло — пробует типичные имена."""
    try:
        names = remote_listing(CFG["base_url"])
        print(f"   В каталоге на сервере файлов: {len(names)}")
    except Exception as e:
        print(f"   ⚠ Листинг каталога недоступен ({e}). Пробую стандартные имена.")
        names = []
    found = {}
    for key, p in PRODUCTS.items():
        cands = [n[:-4] for n in names
                 if n.lower().startswith(p["prefix"]) and n.lower().endswith(".img") and "error" not in n.lower()]
        if cands:
            found[key] = cands[0]
            continue
        for suffix in ("sinu", "sinus", "sin"):
            stem = p["prefix"] + suffix
            try:
                if requests.head(CFG["base_url"] + stem + ".img", timeout=30).status_code == 200:
                    found[key] = stem
                    break
            except requests.RequestException:
                pass
    return found


def download(url, dst, required=True, retries=3):
    if dst.exists() and dst.stat().st_size > 0:
        print(f"   ✓ уже есть: {dst.name}")
        return True
    tmp = dst.with_name(dst.name + ".part")
    for attempt in range(1, retries + 1):
        try:
            with requests.get(url, stream=True, timeout=120) as r:
                r.raise_for_status()
                total = int(r.headers.get("content-length", 0))
                with open(tmp, "wb") as f, tqdm(total=total, unit="B", unit_scale=True, desc=dst.name) as bar:
                    for chunk in r.iter_content(chunk_size=1 << 20):
                        f.write(chunk)
                        bar.update(len(chunk))
            tmp.rename(dst)
            return True
        except Exception as e:
            print(f"   ⚠ {dst.name}: попытка {attempt}/{retries} не удалась ({e})")
            time.sleep(3 * attempt)
    if required:
        raise RuntimeError(f"Не удалось скачать {url}")
    return False


print_header("ЯЧЕЙКА 1. Загрузка Magellan GxDR")
names = local_product_names()
if len(names) < len(PRODUCTS):
    remote = remote_product_names()
    missing = [k for k in PRODUCTS if k not in remote]
    if missing:
        raise RuntimeError(f"На сервере не найдены продукты: {missing}. Проверьте CFG['base_url'] в браузере.")
    for key, stem in remote.items():
        for ext in (".img", ".hdr", ".xml"):
            download(CFG["base_url"] + stem + ext, DATA_DIR / (stem + ext), required=(ext != ".xml"))
    names = local_product_names()
else:
    print("   Все файлы уже скачаны ранее — сеть не нужна.")

(WORK_DIR / "files.json").write_text(json.dumps(names, ensure_ascii=False, indent=2))

summary = pd.DataFrame([{
    "продукт": PRODUCTS[k]["title"],
    "файл": f"{stem}.img",
    "размер, МБ": round((DATA_DIR / f"{stem}.img").stat().st_size / 2**20, 1),
} for k, stem in names.items()])
display(summary)
print(f"   Итого: {summary['размер, МБ'].sum():.0f} МБ в {DATA_DIR}")
