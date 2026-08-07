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
[ "${1:-}" = "--single" ] && THREADED=0

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

# MODULARIZE+EXPORT_ES6 даёт импортируемый модуль — так WASM остаётся отдельным
# артефактом за message-протоколом, что важно для GPL-границы (docs/07 §3).
COMMON_FLAGS="-O3 -sENVIRONMENT=web,worker -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORTED_RUNTIME_METHODS=callMain,FS -sFORCE_FILESYSTEM=1 -sEXIT_RUNTIME=0 -sSTACK_SIZE=5MB"

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
