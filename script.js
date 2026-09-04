const els = {
  score: document.getElementById("score"),
  streak: document.getElementById("streak"),
  wordEmoji: document.getElementById("wordEmoji"),
  englishWord: document.getElementById("englishWord"),
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

let score = 0;
let streak = 0;
let round = 0;
let lastWordIndex = -1;
let locked = false;

function pickRandom(array, count, exclude = []) {
  const pool = array.filter((item) => !exclude.includes(item));
  const picked = [];
  while (picked.length < count && pool.length > 0) {
    const i = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(i, 1)[0]);
  }
  return picked;
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
  els.wordEmoji.textContent = correctWord.emoji;
  els.englishWord.textContent = correctWord.en;

  const wrongWords = pickRandom(
    WORDS.filter((w) => w.he !== correctWord.he),
    2
  );
  const optionWords = shuffle([correctWord, ...wrongWords]);

  els.options.innerHTML = "";
  optionWords.forEach((word) => {
    const btn = document.createElement("button");
    btn.className = "option-btn";
    btn.textContent = word.he;
    btn.addEventListener("click", () => selectOption(btn, word, correctWord));
    els.options.appendChild(btn);
  });
}

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function selectOption(button, chosenWord, correctWord) {
  if (locked) return;
  locked = true;

  const buttons = [...els.options.children];
  const isCorrect = chosenWord.he === correctWord.he;

  if (isCorrect) {
    button.classList.add("correct");
    score += 1;
    streak += 1;
    els.feedback.textContent = "יפה מאוד! 🎉";
    els.feedback.className = "feedback show correct";
  } else {
    button.classList.add("wrong");
    streak = 0;
    els.feedback.textContent = `לא נכון, התשובה היא ${correctWord.he}`;
    els.feedback.className = "feedback show wrong";
    buttons.find((b) => b.textContent === correctWord.he)?.classList.add("correct");
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
