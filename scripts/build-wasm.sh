#!/usr/bin/env bash
# BurstSim — сборка simc в WebAssembly (F0-6/F0-8, docs/02-sim-engine.md §6).
#
# ⚠️ РАБОЧАЯ СБОРКА — МНОГОПОТОЧНАЯ, и это не выбор, а вынужденность.
# Однопоточный путь (SC_NO_THREADING=ON) на ветке midnight НЕ СОБИРАЕТСЯ:
# разваливается подсистема profileset — ядро Top Gear и Droptimizer.
# Подробности и доказательство — decisions/DEAD-ENDS.md в репозитории burstsim.
# Флаг --single оставлен, чтобы можно было перепроверить после обновления
# апстрима, но по умолчанию он не используется.
#
# Исходники simc лежат ОТДЕЛЬНО (ADR-0011): путь берётся из SIMC_DIR.
#
# Использование:
#   source /e/emsdk/emsdk_env.sh
#   ./scripts/build-wasm.sh          # рабочая, многопоточная
#   ./scripts/build-wasm.sh --single # заведомо ломается, только для перепроверки

set -euo pipefail

# Рабочая копия апстрима — рядом, а не внутри этого репозитория.
ROOT="${SIMC_DIR:-/e/simc}"
THREADED=1
DEBUG=0
[ "${1:-}" = "--single" ] && THREADED=0
# Диагностическая сборка (F0-27): та же конфигурация, что рабочая, плюс
# -sASSERTIONS=2 — вместо голого Aborted() рантайм называет причину.
# Отдельная папка: рабочая сборка остаётся нетронутой, канарейки идут по ней.
[ "${1:-}" = "--debug" ] && DEBUG=1

if [ ! -d "$ROOT/engine" ]; then
  echo "ошибка: в $ROOT нет исходников simc. Сначала: ./scripts/sync-upstream.sh" >&2
  exit 1
fi

if ! command -v emcmake >/dev/null 2>&1; then
  echo "ошибка: emcmake не найден. Сначала: source /e/emsdk/emsdk_env.sh" >&2
  exit 1
fi

if [ "$THREADED" = "1" ]; then
  BUILD_DIR="$ROOT/build-wasm-mt"
  # PROXY_TO_PTHREAD уводит main() с UI-потока: иначе блокирующий цикл симуляции
  # вешает вкладку. PTHREAD_POOL_SIZE выставляется рантаймом по hardwareConcurrency.
  EXTRA_FLAGS="-pthread -sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE_STRICT=0 -sINITIAL_MEMORY=1073741824"
  THREAD_OPT="OFF"
else
  BUILD_DIR="$ROOT/build-wasm"
  EXTRA_FLAGS="-sINITIAL_MEMORY=536870912 -sALLOW_MEMORY_GROWTH=1"
  THREAD_OPT="ON"
fi

if [ "$DEBUG" = "1" ]; then
  BUILD_DIR="${BUILD_DIR}-debug"
  EXTRA_FLAGS="$EXTRA_FLAGS -sASSERTIONS=2"
fi

# MODULARIZE+EXPORT_ES6 даёт импортируемый модуль — так WASM остаётся отдельным
# артефактом за message-протоколом, что важно для GPL-границы (docs/07 §3).
#
# ⚠️ -fwasm-exceptions ОБЯЗАТЕЛЕН (найдено 2026-08-08, F0-27). Дефолт Emscripten
# собирает без поддержки исключений, и любой throw становится abort(). А движок
# бросает исключения ШТАТНО: разбор хотфиксов игровых данных кидает
# invalid_argument на кривом поле («stoul: no conversion»), native ловит его и
# продолжает — WASM без этого флага умирал. Именно так падали 4 профиля из 12
# (Blood DK, Frost Mage, Shadow Priest, Devastation Evoker): в их данных есть
# такие хотфиксы, у остальных восьми — нет. Это не наш патч движка: флаг —
# часть обвязки сборки, патч-стек остаётся пустым.
# ⚠️ node в ENVIRONMENT — для канареек и smoke-тестов (2026-08-08). Свежий glue
# без него не умеет под Node ни читать wasm с диска, ни поднимать воркеры, — и
# прогонщик умирал на «both async and sync fetching of the wasm failed» ещё до
# движка. Браузеру ветка не мешает: в рантайме она мертва.
COMMON_FLAGS="-O3 -fwasm-exceptions -sENVIRONMENT=web,worker,node -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORTED_RUNTIME_METHODS=callMain,FS -sFORCE_FILESYSTEM=1 -sEXIT_RUNTIME=0 -sSTACK_SIZE=5MB"

echo "==> Конфигурация ($([ "$THREADED" = "1" ] && echo многопоточная || echo однопоточная)) → $BUILD_DIR"
emcmake cmake -S "$ROOT" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_GUI=OFF \
  -DBUILD_TESTING=OFF \
  -DSC_NO_THREADING="$THREAD_OPT" \
  -DSC_NO_NETWORKING=ON \
  -DCMAKE_CXX_FLAGS="$COMMON_FLAGS $EXTRA_FLAGS" \
  -DCMAKE_EXE_LINKER_FLAGS="$COMMON_FLAGS $EXTRA_FLAGS"

echo "==> Сборка"
cmake --build "$BUILD_DIR" -j "$(nproc 2>/dev/null || echo 8)"

echo "==> Артефакты:"
find "$BUILD_DIR" -name "*.wasm" -o -name "simc*.js" | head
