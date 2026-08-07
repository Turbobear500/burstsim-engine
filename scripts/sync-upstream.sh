#!/usr/bin/env bash
# Приводит рабочую копию апстрима к закреплённому SHA из upstream.json.
#
# ⚠️ Исходники simc в этом репозитории НЕ ЛЕЖАТ (ADR-0011). Полная история
# апстрима весит около 5 ГБ при нулевых наших правках — копировать её ради
# нуля бессмысленно. Здесь только обвязка и закреплённый SHA; сам код
# клонируется рядом и обновляется этим скриптом.
#
# Куда клонировать: переменная SIMC_DIR (по умолчанию E:/simc).
#
#   ./scripts/sync-upstream.sh          # привести к закреплённому SHA
#   ./scripts/sync-upstream.sh --latest # показать, что приехало в апстрим (не трогая копию)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIMC_DIR="${SIMC_DIR:-/e/simc}"

read_json() { node -p "JSON.parse(require('fs').readFileSync('$HERE/upstream.json','utf8')).$1"; }
REPO="$(read_json repo)"
BRANCH="$(read_json branch)"
SHA="$(read_json sha)"

# ⚠️ ЗАКРЕПЛЁННЫЙ КОММИТ ТЯНЕМ ПО SHA, а не «ветку на N коммитов назад».
# Первая версия клонировала с --depth 50 и делала checkout: на ветке midnight
# 10–20 коммитов в сутки, полсотни покрывают пару дней, и через неделю после
# закрепления коммита в клоне уже нет. Ошибка появляется СО ВРЕМЕНЕМ — в день
# написания скрипт работает. Fetch по SHA требует полного хэша (он в upstream.json).
if [ ! -d "$SIMC_DIR/.git" ]; then
  echo "==> Рабочей копии нет — создаю $SIMC_DIR"
  mkdir -p "$SIMC_DIR"
  git -C "$SIMC_DIR" init -q
  git -C "$SIMC_DIR" remote add origin "$REPO"
fi

if [ "${1:-}" = "--latest" ]; then
  git -C "$SIMC_DIR" fetch --depth 200 origin "$BRANCH"
  echo "==> Приехало в апстрим после закреплённого $SHA:"
  git -C "$SIMC_DIR" log --oneline "$SHA..FETCH_HEAD" | head -30
  exit 0
fi

echo "==> Привожу $SIMC_DIR к закреплённому $SHA"
git -C "$SIMC_DIR" fetch --depth 1 origin "$SHA"
git -C "$SIMC_DIR" checkout -q --detach FETCH_HEAD

# Патчей сейчас ноль, и это состояние защищается решением, а не дисциплиной.
PATCHES="$HERE/patches"
if [ -d "$PATCHES" ] && [ -n "$(ls -A "$PATCHES" 2>/dev/null)" ]; then
  echo "==> Накладываю патчи"
  for p in "$PATCHES"/*.patch; do
    echo "    $p"
    git -C "$SIMC_DIR" apply "$p"
  done
else
  echo "==> Патчей нет — как и должно быть (ADR-0005)"
fi

echo "==> Готово: $(git -C "$SIMC_DIR" log --oneline -1)"
