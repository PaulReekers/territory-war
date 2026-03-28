/*
 * Territory War — js/game.js
 *
 * Assumptions:
 * - Grid: 60 cols × 40 rows, CELL_SIZE=10px, GAP=1px → canvas 659×439px.
 * - Ownership: grid[row][col] = player index (0,1,2) or EMPTY (-1).
 * - Players: 0=Greedy(orange), 1=Border(dark gray), 2=Hunter(green/human).
 * - Movement is 4-directional only (no diagonals).
 * - A player may move into their own cells but NOT into another player's cells.
 * - PathFinding.js: PF.AStarFinder (no diagonal); fresh PF.Grid per search.
 *   Other players' cells are marked non-walkable; own cells are walkable.
 * - BFS for nearest-empty also respects movement constraints (can't cross opponents).
 * - Collision: if next step targets another player's HEAD, skip turn (stay put).
 * - After every move, enclosed empty regions surrounded by one player are auto-claimed.
 *   "Enclosed" = connected EMPTY component that does not touch the grid edge,
 *   whose entire border consists of cells owned by exactly one player.
 * - End condition checked after each complete round (AI moves + human move/skip).
 * - "No player moved" = greedy skipped AND border skipped AND human had no valid moves.
 * - setInterval drives tick updates; requestAnimationFrame drives rendering.
 */

const COLS = 40;
const ROWS = 40;
const CELL_SIZE = 10;
const GAP = 1;
const STEP = CELL_SIZE + GAP;
const TOTAL_CELLS = COLS * ROWS;
const EMPTY = -1;

const PLAYER_COLORS = ['#e8820c', '#888888', '#27ae60'];
const PLAYER_NAMES  = ['Greedy', 'Border', 'Hunter'];
const PLAYER_STRATS = ['Greedy AI', 'Border AI', 'You'];
const EMPTY_COLOR   = '#cec6ba';

// 4-directional only
const DIRS = [[0,-1],[0,1],[-1,0],[1,0]];

let canvas, ctx;
let domRefs = {};

let gameState = {
  grid: [],
  players: [],
  phase: 'AI',       // 'AI' | 'HUMAN_WAIT'
  tick: 0,
  status: 'running', // 'running' | 'ended'
  fps: 10,
  paused: false,
  intervalId: null,
  movedAI: false
};

// ─── Init ────────────────────────────────────────────────────────────────────

function initGame() {
  canvas = document.getElementById('gameCanvas');
  ctx    = canvas.getContext('2d');
  canvas.width  = COLS * STEP - GAP;
  canvas.height = ROWS * STEP - GAP;

  domRefs = {
    playPauseBtn:  document.getElementById('playPauseBtn'),
    speedSlider:   document.getElementById('speedSlider'),
    fpsLabel:      document.getElementById('fpsLabel'),
    statusMsg:     document.getElementById('statusMsg'),
    gameOverPanel: document.getElementById('game-over-panel'),
    winnerText:    document.getElementById('winner-text'),
    scoreRows:     [0,1,2].map(i => document.getElementById('score-row-' + i)),
    cellsEls:      [0,1,2].map(i => document.getElementById('cells-' + i)),
    pctEls:        [0,1,2].map(i => document.getElementById('pct-' + i))
  };

  gameState.grid = [];
  for (let r = 0; r < ROWS; r++) gameState.grid[r] = new Array(COLS).fill(EMPTY);

  gameState.players = [];
  gameState.phase   = 'AI';
  gameState.tick    = 0;
  gameState.status  = 'running';
  gameState.paused  = false;
  gameState.movedAI = false;

  let positions = tryPlacePlayers(6) || tryPlacePlayers(3);
  if (!positions) positions = [{ x: 10, y: 10 }, { x: 30, y: 20 }, { x: 50, y: 30 }];

  for (let i = 0; i < 3; i++) {
    gameState.players.push({
      head:     { ...positions[i] },
      color:    PLAYER_COLORS[i],
      name:     PLAYER_NAMES[i],
      strategy: PLAYER_STRATS[i],
      index:    i
    });
    gameState.grid[positions[i].y][positions[i].x] = i;
  }

  canvas.addEventListener('click', handleClick);
  window.addEventListener('keydown', handleKey);
  domRefs.playPauseBtn.addEventListener('click', togglePause);
  domRefs.speedSlider.addEventListener('input', onSpeedChange);

  startLoop();
  requestAnimationFrame(renderLoop);
}

function tryPlacePlayers(minDist) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const positions = [];
    let valid = true;
    for (let i = 0; i < 3; i++) {
      let pos = null;
      for (let t = 0; t < 10000; t++) {
        const x = Math.floor(Math.random() * COLS);
        const y = Math.floor(Math.random() * ROWS);
        let ok = true;
        for (const p of positions) {
          if (Math.abs(p.x - x) + Math.abs(p.y - y) < minDist) { ok = false; break; }
        }
        if (ok) { pos = { x, y }; break; }
      }
      if (!pos) { valid = false; break; }
      positions.push(pos);
    }
    if (valid) return positions;
  }
  return null;
}

// ─── Loop control ────────────────────────────────────────────────────────────

function startLoop() {
  if (gameState.intervalId) clearInterval(gameState.intervalId);
  gameState.intervalId = setInterval(() => {
    if (!gameState.paused && gameState.phase === 'AI' && gameState.status === 'running') {
      update();
    }
  }, 1000 / gameState.fps);
}

function renderLoop() {
  render();
  requestAnimationFrame(renderLoop);
}

function togglePause() {
  gameState.paused = !gameState.paused;
  domRefs.playPauseBtn.textContent = gameState.paused ? 'Play' : 'Pause';
}

function onSpeedChange() {
  gameState.fps = parseInt(domRefs.speedSlider.value, 10);
  domRefs.fpsLabel.textContent = gameState.fps + ' FPS';
  startLoop();
}

// ─── Update (AI tick) ────────────────────────────────────────────────────────

function update() {
  if (gameState.status !== 'running' || gameState.phase !== 'AI') return;

  const g0 = greedyMove(0);
  if (g0) { floodFillCheck(); if (checkMajority()) return; }
  const g1 = borderMove(1);
  if (g1) { floodFillCheck(); if (checkMajority()) return; }
  gameState.movedAI = g0 || g1;
  gameState.tick++;

  const h2 = gameState.players[2].head;

  // If neither AI could move, check whether human has already won or is projected to win
  // by claiming all empty cells still reachable through their own territory.
  if (!gameState.movedAI) {
    const reachable = countReachableEmpty(h2, 2);
    if (reachable > 0) {
      const counts = countAllCells();
      const aiMax = Math.max(counts[0], counts[1]);
      // Human wins if currently ahead OR projected ahead after claiming reachable empty cells
      if (counts[2] > aiMax || counts[2] + reachable > aiMax) {
        endGame('ai_stuck', 2);
        return;
      }
    }
  }

  // Human gets a turn only if at least one EMPTY cell is reachable via own territory.
  const humanCanReach = bfsNearestEmpty(h2.x, h2.y, 2) !== null;

  if (!humanCanReach) {
    checkRoundEnd(false);
  } else {
    gameState.phase = 'HUMAN_WAIT';
    canvas.classList.add('human-turn');
    domRefs.statusMsg.classList.add('human-turn');
    domRefs.statusMsg.textContent = 'Your turn — click or use WASD / arrow keys';
  }
}

function checkRoundEnd(humanMoved) {
  const anyMoved = gameState.movedAI || humanMoved;
  if (countEmpty() === 0 || !anyMoved) {
    endGame('normal');
  } else {
    gameState.phase = 'AI';
    canvas.classList.remove('human-turn');
    domRefs.statusMsg.classList.remove('human-turn');
    domRefs.statusMsg.textContent = 'Playing';
  }
}

function countEmpty() {
  let n = 0;
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      if (gameState.grid[r][c] === EMPTY) n++;
  return n;
}

// Returns EMPTY cells 4-adjacent to head (used for render highlight)
function getAdjacentEmpty(head) {
  const moves = [];
  for (const [dx, dy] of DIRS) {
    const nx = head.x + dx, ny = head.y + dy;
    if (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS && gameState.grid[ny][nx] === EMPTY)
      moves.push({ x: nx, y: ny });
  }
  return moves;
}

// Returns all cells the human can legally step onto: EMPTY or own cells.
// Used for auto-skip decision — human gets a turn as long as any step is possible.
function getAdjacentValid(head) {
  const moves = [];
  for (const [dx, dy] of DIRS) {
    const nx = head.x + dx, ny = head.y + dy;
    if (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS) {
      const v = gameState.grid[ny][nx];
      if (v === EMPTY || v === 2) moves.push({ x: nx, y: ny });
    }
  }
  return moves;
}

// Count cells owned by each player.
function countAllCells() {
  const counts = [0, 0, 0];
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const v = gameState.grid[r][c];
      if (v >= 0) counts[v]++;
    }
  return counts;
}

// BFS from head through own + empty cells; returns number of EMPTY cells reachable.
function countReachableEmpty(head, playerIdx) {
  const visited = new Uint8Array(COLS * ROWS);
  const startIdx = head.x + head.y * COLS;
  visited[startIdx] = 1;
  const queue = [startIdx];
  let empty = 0;
  while (queue.length > 0) {
    const idx = queue.shift();
    const cx = idx % COLS, cy = (idx / COLS) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
      const nidx = nx + ny * COLS;
      if (visited[nidx]) continue;
      const v = gameState.grid[ny][nx];
      if (v !== EMPTY && v !== playerIdx) continue;
      visited[nidx] = 1;
      if (v === EMPTY) empty++;
      queue.push(nidx);
    }
  }
  return empty;
}

// ─── Pathfinding helpers ──────────────────────────────────────────────────────

// PF.Grid where other players' cells are obstacles; own + empty are walkable.
function buildPFGrid(playerIdx) {
  const pfGrid = new PF.Grid(COLS, ROWS);
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const v = gameState.grid[r][c];
      if (v !== EMPTY && v !== playerIdx)
        pfGrid.setWalkableAt(c, r, false);
    }
  return pfGrid;
}

// BFS constrained to own + empty cells; returns nearest reachable EMPTY cell.
function bfsNearestEmpty(startX, startY, playerIdx) {
  const visited = new Uint8Array(COLS * ROWS);
  const startIdx = startX + startY * COLS;
  visited[startIdx] = 1;
  const queue = [startIdx];

  while (queue.length > 0) {
    const idx = queue.shift();
    const cx  = idx % COLS;
    const cy  = (idx / COLS) | 0;

    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
      const nidx = nx + ny * COLS;
      if (visited[nidx]) continue;
      const v = gameState.grid[ny][nx];
      // Can only traverse own cells or empty cells
      if (v !== EMPTY && v !== playerIdx) continue;
      visited[nidx] = 1;
      if (v === EMPTY) return { x: nx, y: ny };
      queue.push(nidx);
    }
  }
  return null;
}

function isHeadCollision(playerIdx, nx, ny) {
  for (let i = 0; i < gameState.players.length; i++) {
    if (i !== playerIdx) {
      const h = gameState.players[i].head;
      if (h.x === nx && h.y === ny) return true;
    }
  }
  return false;
}

// ─── Strategies ──────────────────────────────────────────────────────────────

function greedyMove(playerIdx) {
  const player = gameState.players[playerIdx];
  const target = bfsNearestEmpty(player.head.x, player.head.y, playerIdx);
  if (!target) return false;

  const pfGrid = buildPFGrid(playerIdx);
  const finder = new PF.AStarFinder();
  const path   = finder.findPath(player.head.x, player.head.y, target.x, target.y, pfGrid);

  if (!path || path.length < 2) return false;

  const [stepX, stepY] = path[1];
  if (isHeadCollision(playerIdx, stepX, stepY)) return false;

  player.head = { x: stepX, y: stepY };
  gameState.grid[stepY][stepX] = playerIdx;
  return true;
}

function borderMove(playerIdx) {
  const player = gameState.players[playerIdx];

  const owned = [];
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      if (gameState.grid[r][c] === playerIdx) owned.push({ x: c, y: r });

  if (owned.length === 0) return false;

  const centX = owned.reduce((s, p) => s + p.x, 0) / owned.length;
  const centY = owned.reduce((s, p) => s + p.y, 0) / owned.length;

  // Border cells: owned cells with ≥1 EMPTY 4-neighbour
  const borderCells = owned.filter(p => {
    for (const [dx, dy] of DIRS) {
      const nx = p.x + dx, ny = p.y + dy;
      if (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS && gameState.grid[ny][nx] === EMPTY)
        return true;
    }
    return false;
  });
  if (borderCells.length === 0) return false;

  borderCells.sort((a, b) => {
    const da = (a.x - centX) ** 2 + (a.y - centY) ** 2;
    const db = (b.x - centX) ** 2 + (b.y - centY) ** 2;
    return db - da;
  });
  const borderCell = borderCells[0];

  let target = null;
  for (const [dx, dy] of DIRS) {
    const nx = borderCell.x + dx, ny = borderCell.y + dy;
    if (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS && gameState.grid[ny][nx] === EMPTY) {
      target = { x: nx, y: ny };
      break;
    }
  }
  if (!target) return false;

  const pfGrid = buildPFGrid(playerIdx);
  const finder = new PF.AStarFinder();
  const path   = finder.findPath(player.head.x, player.head.y, target.x, target.y, pfGrid);

  if (!path || path.length < 2) return false;

  const [stepX, stepY] = path[1];
  if (isHeadCollision(playerIdx, stepX, stepY)) return false;

  player.head = { x: stepX, y: stepY };
  gameState.grid[stepY][stepX] = playerIdx;
  return true;
}

// ─── Flood fill ───────────────────────────────────────────────────────────────

// Auto-claim any EMPTY region fully enclosed by one player's cells.
// Runs repeatedly until no new enclosures are found.
function floodFillCheck() {
  let changed = true;
  while (changed) {
    changed = false;
    const visited = new Uint8Array(COLS * ROWS);

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (gameState.grid[r][c] !== EMPTY || visited[r * COLS + c]) continue;

        // BFS to map the connected EMPTY component
        const component = [];
        const queue = [c + r * COLS];
        visited[c + r * COLS] = 1;
        let touchesEdge = false;
        const surrounding = new Set();

        while (queue.length > 0) {
          const idx = queue.shift();
          const cx = idx % COLS, cy = (idx / COLS) | 0;
          component.push(idx);
          if (cx === 0 || cx === COLS - 1 || cy === 0 || cy === ROWS - 1) touchesEdge = true;

          for (const [dx, dy] of DIRS) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
            const nidx = nx + ny * COLS;
            const v = gameState.grid[ny][nx];
            if (v === EMPTY) {
              if (!visited[nidx]) { visited[nidx] = 1; queue.push(nidx); }
            } else {
              surrounding.add(v);
            }
          }
        }

        // Claim only if not open to edge and bordered by exactly one player
        if (!touchesEdge && surrounding.size === 1) {
          const owner = [...surrounding][0];
          for (const idx of component) {
            gameState.grid[(idx / COLS) | 0][idx % COLS] = owner;
          }
          changed = true;
        }
      }
    }
  }
}

// ─── Human input ─────────────────────────────────────────────────────────────

const KEY_DIRS = {
  ArrowUp:    [ 0, -1], ArrowDown:  [ 0,  1],
  ArrowLeft:  [-1,  0], ArrowRight: [ 1,  0],
  w: [ 0, -1], s: [ 0,  1],
  a: [-1,  0], d: [ 1,  0]
};

function handleKey(e) {
  if (gameState.phase !== 'HUMAN_WAIT' || gameState.status !== 'running') return;
  const dir = KEY_DIRS[e.key];
  if (!dir) return;
  e.preventDefault();

  const player = gameState.players[2];
  const nx = player.head.x + dir[0];
  const ny = player.head.y + dir[1];

  if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) return;
  const v = gameState.grid[ny][nx];
  // Allow empty or own cells; block other players' cells
  if (v !== EMPTY && v !== 2) return;

  player.head = { x: nx, y: ny };
  gameState.grid[ny][nx] = 2;
  floodFillCheck();
  if (!checkMajority()) checkRoundEnd(true);
}

function handleClick(e) {
  if (gameState.phase !== 'HUMAN_WAIT' || gameState.status !== 'running') return;

  const rect   = canvas.getBoundingClientRect();
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  const mx     = (e.clientX - rect.left) * scaleX;
  const my     = (e.clientY - rect.top)  * scaleY;

  const col = Math.floor(mx / STEP);
  const row = Math.floor(my / STEP);

  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return;

  const player = gameState.players[2];
  const { x, y } = player.head;

  // Must be exactly 1 step away in a cardinal direction
  if (Math.abs(col - x) + Math.abs(row - y) !== 1) return;
  const v = gameState.grid[row][col];
  if (v !== EMPTY && v !== 2) return;

  player.head = { x: col, y: row };
  gameState.grid[row][col] = 2;
  floodFillCheck();
  if (!checkMajority()) checkRoundEnd(true);
}

// ─── Majority check ───────────────────────────────────────────────────────────

// Returns true (and ends the game) if any player owns more than 50% of all cells.
function checkMajority() {
  if (gameState.status !== 'running') return false;
  const counts = countAllCells();
  for (let i = 0; i < 3; i++) {
    if (counts[i] > TOTAL_CELLS / 2) {
      endGame('majority', i);
      return true;
    }
  }
  return false;
}

// ─── End game ────────────────────────────────────────────────────────────────

// reason: 'majority' → >50% claimed  |  'ai_stuck' → AI frozen, human wins  |  'normal'
function endGame(reason, forcedWinner) {
  gameState.status = 'ended';
  gameState.phase  = 'AI';
  canvas.classList.remove('human-turn');
  domRefs.statusMsg.classList.remove('human-turn');
  domRefs.statusMsg.textContent = 'Game Over';

  const counts = countAllCells();

  // Winner is explicit for early endings; highest count for normal end.
  const winnerIdx = (reason !== 'normal') ? forcedWinner : counts.indexOf(Math.max(...counts));
  const winCells  = counts[winnerIdx];
  const winPct    = ((winCells / TOTAL_CELLS) * 100).toFixed(1);

  for (let i = 0; i < 3; i++)
    domRefs.scoreRows[i].classList.toggle('winner', i === winnerIdx);

  domRefs.gameOverPanel.classList.remove('hidden');

  if (reason === 'majority' && winnerIdx === 2) {
    domRefs.winnerText.textContent = 'You won! 🎉 (' + winPct + '% — majority reached)';
  } else if (reason === 'majority') {
    domRefs.winnerText.textContent =
      PLAYER_NAMES[winnerIdx] + ' wins! ' + winPct + '% — majority reached';
  } else if (reason === 'ai_stuck') {
    domRefs.winnerText.textContent =
      'You won! 🎉 AI players are stuck — you claim the rest (' + winPct + '% now)';
  } else {
    domRefs.winnerText.textContent =
      PLAYER_NAMES[winnerIdx] + ' wins with ' + winCells + ' cells (' + winPct + '%)';
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const owner = gameState.grid[r][c];
      ctx.fillStyle = owner === EMPTY ? EMPTY_COLOR : gameState.players[owner].color;
      drawRoundedRect(c * STEP, r * STEP, CELL_SIZE, CELL_SIZE, 2);
      ctx.fill();
    }
  }

  // Highlight valid human moves during HUMAN_WAIT:
  //   EMPTY neighbours → bright white overlay (new territory)
  //   Own-color neighbours → subtle white overlay (traversal only)
  if (gameState.phase === 'HUMAN_WAIT' && gameState.status === 'running') {
    const h = gameState.players[2].head;
    for (const [dx, dy] of DIRS) {
      const nx = h.x + dx, ny = h.y + dy;
      if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
      const v = gameState.grid[ny][nx];
      if (v === EMPTY) {
        ctx.fillStyle = 'rgba(255,255,255,0.42)';
        drawRoundedRect(nx * STEP, ny * STEP, CELL_SIZE, CELL_SIZE, 2);
        ctx.fill();
      } else if (v === 2) {
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        drawRoundedRect(nx * STEP, ny * STEP, CELL_SIZE, CELL_SIZE, 2);
        ctx.fill();
      }
    }
  }

  // Draw heads with eyes
  for (const player of gameState.players) {
    const px = player.head.x * STEP;
    const py = player.head.y * STEP;

    ctx.fillStyle = player.color;
    drawRoundedRect(px, py, CELL_SIZE, CELL_SIZE, 2);
    ctx.fill();

    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(px + 3, py + 3.5, 1.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px + 7, py + 3.5, 1.3, 0, Math.PI * 2);
    ctx.fill();
  }

  updateScorePanel();
}

function drawRoundedRect(x, y, w, h, r) {
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y,     x + w, y + r,     r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x,     y + h, x,     y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x,     y,     x + r, y,         r);
    ctx.closePath();
  }
}

function updateScorePanel() {
  const counts = countAllCells();
  for (let i = 0; i < 3; i++) {
    const pct = ((counts[i] / TOTAL_CELLS) * 100).toFixed(1);
    domRefs.cellsEls[i].textContent = counts[i];
    domRefs.pctEls[i].textContent   = pct + '%';
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

initGame();
