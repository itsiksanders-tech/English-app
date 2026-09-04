const els = {
  score: document.getElementById("score"),
  streak: document.getElementById("streak"),
  prompt: document.getElementById("prompt"),
  options: document.getElementById("options"),
  feedback: document.getElementById("feedback"),
  game: document.getElementById("game"),
  celebration: document.getElementById("celebration"),
  celebrationScore: document.getElementById("celebrationScore"),
  confettiLayer: document.getElementById("confettiLayer"),
  playAgainBtn: document.getElementById("playAgainBtn"),
};

const CONFETTI_EMOJI = ["🎉", "⭐", "🎈", "🏅", "✨"];
const ROUNDS_PER_SESSION = 10;
const CORRECT_ADVANCE_DELAY = 900;

// Each round shows the word in one form and asks the kid to pick its
// match in a different form, so a picture is never shown alongside the
// English word it would give away.
const ROUND_TYPES = [
  { prompt: "en", options: "he" },
  { prompt: "he", options: "en" },
  { prompt: "emoji", options: "en" },
  { prompt: "en", options: "emoji" },
];

let score = 0;
let streak = 0;
let round = 0;
let lastWordIndex = -1;
let locked = false;

function optionKey(word, kind) {
  return kind === "he" ? word.he : kind === "en" ? word.en : word.emoji;
}

function pickRandom(array, count) {
  const pool = [...array];
  const picked = [];
  while (picked.length < count && pool.length > 0) {
    const i = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(i, 1)[0]);
  }
  return picked;
}

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function renderPrompt(word, kind) {
  els.prompt.className = `prompt kind-${kind}`;
  els.prompt.textContent = optionKey(word, kind);
}

function renderOption(word, kind) {
  const btn = document.createElement("button");
  btn.className = "option-btn" + (kind === "en" ? " lang-en" : kind === "emoji" ? " emoji-option" : "");
  btn.textContent = optionKey(word, kind);
  btn.dataset.key = optionKey(word, kind);
  return btn;
}

function nextRound() {
  round += 1;
  if (round > ROUNDS_PER_SESSION) {
    showCelebration();
    return;
  }

  locked = false;
  els.feedback.textContent = "";
  els.feedback.className = "feedback";

  let index;
  do {
    index = Math.floor(Math.random() * WORDS.length);
  } while (index === lastWordIndex && WORDS.length > 1);
  lastWordIndex = index;

  const correctWord = WORDS[index];
  const roundType = ROUND_TYPES[Math.floor(Math.random() * ROUND_TYPES.length)];

  renderPrompt(correctWord, roundType.prompt);

  const correctKey = optionKey(correctWord, roundType.options);
  const wrongPool = WORDS.filter((w) => optionKey(w, roundType.options) !== correctKey);
  const optionWords = shuffle([correctWord, ...pickRandom(wrongPool, 2)]);

  els.options.innerHTML = "";
  optionWords.forEach((word) => {
    const btn = renderOption(word, roundType.options);
    btn.addEventListener("click", () => selectOption(btn, correctKey));
    els.options.appendChild(btn);
  });
}

function selectOption(button, correctKey) {
  if (locked) return;
  locked = true;

  const buttons = [...els.options.children];
  const isCorrect = button.dataset.key === correctKey;

  if (isCorrect) {
    button.classList.add("correct");
    score += 1;
    streak += 1;
    els.feedback.textContent = "יפה מאוד! 🎉";
    els.feedback.className = "feedback show correct";
  } else {
    button.classList.add("wrong");
    streak = 0;
    els.feedback.textContent = `לא נכון, התשובה היא ${correctKey}`;
    els.feedback.className = "feedback show wrong";
    buttons.find((b) => b.dataset.key === correctKey)?.classList.add("correct");
  }

  els.score.textContent = score;
  els.streak.textContent = streak;
  buttons.forEach((b) => (b.disabled = true));

  setTimeout(nextRound, isCorrect ? CORRECT_ADVANCE_DELAY : CORRECT_ADVANCE_DELAY + 700);
}

function showCelebration() {
  els.game.classList.add("hidden");
  els.celebration.classList.remove("hidden");
  els.celebrationScore.textContent = `${score} מתוך ${ROUNDS_PER_SESSION}`;

  els.confettiLayer.innerHTML = "";
  for (let i = 0; i < 18; i++) {
    const piece = document.createElement("span");
    piece.className = "confetti";
    piece.textContent = CONFETTI_EMOJI[Math.floor(Math.random() * CONFETTI_EMOJI.length)];
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.animationDelay = `${Math.random() * 2}s`;
    piece.style.animationDuration = `${2.6 + Math.random() * 1.6}s`;
    els.confettiLayer.appendChild(piece);
  }
}

function restartSession() {
  score = 0;
  streak = 0;
  round = 0;
  els.score.textContent = "0";
  els.streak.textContent = "0";
  els.celebration.classList.add("hidden");
  els.game.classList.remove("hidden");
  nextRound();
}

els.playAgainBtn.addEventListener("click", restartSession);

nextRound();
