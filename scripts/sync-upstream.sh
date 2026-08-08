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

# ⚠️ Файл подаётся через stdin, а не путём в аргументе (починено 2026-08-08
# живым прогоном): node на Windows читает msys-путь `/e/…` как `E:\e\…`, и
# скрипт умирал на первом же вызове — то есть НЕ РАБОТАЛ НИ РАЗУ с момента
# написания. Редирект делает bash, ему msys-пути родные.
read_json() { node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).$1" < "$HERE/upstream.json"; }
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
  # Fetch по URL, а не по имени remote: в рабочей копии он может зваться как угодно
  # (у нас — upstream с июльского клона; поймано живым прогоном 2026-08-08).
  git -C "$SIMC_DIR" fetch --depth 200 "$REPO" "$BRANCH"
  TIP="$(git -C "$SIMC_DIR" rev-parse FETCH_HEAD)"
  echo "==> Верхушка $BRANCH: $TIP"
  # Связность в пределах глубины не гарантирована: апстрим делает 10–20
  # коммитов в день, и закреплённый коммит двухнедельной давности может
  # оказаться за шельфом. Тогда счёт «что приехало» невозможен — говорим об
  # этом прямо, а не показываем усечённый список как полный.
  if git -C "$SIMC_DIR" merge-base --is-ancestor "$SHA" FETCH_HEAD 2>/dev/null; then
    N="$(git -C "$SIMC_DIR" rev-list --count "$SHA..FETCH_HEAD")"
    echo "==> Приехало после закреплённого $SHA: $N коммитов"
    git -C "$SIMC_DIR" log --oneline "$SHA..FETCH_HEAD" | head -30
  else
    echo "==> ⚠️ Закреплённый коммит вне глубины выборки (новых больше ~200)."
    echo "    Полного счёта нет; свежие коммиты:"
    git -C "$SIMC_DIR" log --oneline FETCH_HEAD | head -20
  fi
  echo "==> Новый SHA для upstream.json (если решаем обновляться): $TIP"
  exit 0
fi

echo "==> Привожу $SIMC_DIR к закреплённому $SHA"
git -C "$SIMC_DIR" fetch --depth 1 "$REPO" "$SHA"
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
