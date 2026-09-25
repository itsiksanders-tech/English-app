import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInAnonymously,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  increment,
  serverTimestamp,
  collection,
  getDocs,
  query,
  orderBy,
  limit,
  documentId,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

// ---- Curriculum: age -> tier -> per-word mastery ----
//
// Words are grouped into 60 tiers (5 sub-levels per age, ages 3-14).
// A kid's age picks their starting tier; from there, an "active pool"
// of words is tracked personally (persisted on their profile). Each
// pool word climbs the same 3 mastery stages sprint mode uses
// (choice -> typeChoice -> type); once it clears "type" it's
// mastered and is swapped out for a new word pulled from the NEXT
// tier. Once most of the pool is made up of next-tier words, the
// whole tier advances - so the pool gradually and continuously
// drifts upward instead of jumping in one lump.
const AGE_MIN = 3;
const AGE_MAX = 14;
const SUBLEVELS_PER_AGE = 5;
const MAX_TIER = (AGE_MAX - AGE_MIN + 1) * SUBLEVELS_PER_AGE; // 60
const ACTIVE_POOL_SIZE = 10;
const MASTERY_STAGES = ["choice", "typeChoice", "type"];

function startingTierForAge(age) {
  const clamped = Math.min(Math.max(Math.round(age) || AGE_MIN, AGE_MIN), AGE_MAX);
  return (clamped - AGE_MIN) * SUBLEVELS_PER_AGE + 1;
}

function ageAndSubLevelForTier(tier) {
  const idx = Math.min(Math.max(tier, 1), MAX_TIER) - 1;
  return { age: AGE_MIN + Math.floor(idx / SUBLEVELS_PER_AGE), subLevel: (idx % SUBLEVELS_PER_AGE) + 1 };
}

function wordsInTier(tier) {
  return window.WORDS.filter((w) => w.tier === tier);
}

function wordTierOf(en) {
  return window.WORDS.find((w) => w.en === en)?.tier;
}

function pickUnseenFrom(list, seenWords) {
  const candidates = list.filter((w) => !seenWords.includes(w.en));
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// Tries the preferred tier first, then falls back progressively wider
// so a sparsely-populated tier never breaks the pool - it just pulls
// from further afield instead.
function pickCurriculumWord(progress, preferredTier) {
  return (
    pickUnseenFrom(wordsInTier(preferredTier), progress.seenWords) ||
    pickUnseenFrom(wordsInTier(progress.currentTier), progress.seenWords) ||
    pickUnseenFrom(window.WORDS.filter((w) => w.tier <= progress.currentTier), progress.seenWords) ||
    pickUnseenFrom(window.WORDS, progress.seenWords)
  );
}

function initialCurriculumProgress(age) {
  const tier = startingTierForAge(age);
  const progress = { currentTier: tier, activePool: [], seenWords: [] };
  for (let i = 0; i < ACTIVE_POOL_SIZE; i++) {
    const word = pickCurriculumWord(progress, tier);
    if (!word) break;
    progress.activePool.push({ en: word.en, stage: 0 });
    progress.seenWords.push(word.en);
  }
  return progress;
}

function usernameKey(name) {
  return name.trim().toLowerCase();
}

function randomId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return Array.from(window.crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Firebase signs the user in the instant createUserWithEmailAndPassword
// resolves, which can fire onAuthStateChanged before the profile doc
// below finishes writing. This flag tells that listener to stand back
// while signUp() is driving the flow itself, so it never mistakes a
// brand-new user for one with a missing profile and signs them back out.
let signingUp = false;

async function signUp(name, age, password) {
  const key = usernameKey(name);
  if (!key) throw new Error("נא להזין שם");

  const usernameRef = doc(db, "usernames", key);
  const existing = await getDoc(usernameRef);
  if (existing.exists()) throw new Error("השם הזה תפוס, נסה שם אחר");

  const email = `${randomId()}@word-game.local`;
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  const uid = credential.user.uid;

  await setDoc(usernameRef, { uid, email });
  const profile = {
    name: name.trim(),
    age,
    totalCorrect: 0,
    totalWrong: 0,
    masteredWords: [],
    ...initialCurriculumProgress(age),
  };
  await setDoc(doc(db, "users", uid), { ...profile, createdAt: serverTimestamp() });

  currentUid = uid;
  currentProfile = profile;
  enterGame(profile);
}

// A quick-play guest: no name, no password, no lookup-by-login
// later (an anonymous Firebase Auth user, not tied to any username
// mapping, with an auto-generated display name) - just the age, so
// the level curve still starts in the right place. Meant for a
// one-off session, not a returning player - progress lives only as
// long as this device stays signed into that anonymous account.
async function signUpGuest(age) {
  const credential = await signInAnonymously(auth);
  const uid = credential.user.uid;

  const profile = {
    name: `אורח ${Math.floor(1000 + Math.random() * 9000)}`,
    age,
    totalCorrect: 0,
    totalWrong: 0,
    masteredWords: [],
    guest: true,
    ...initialCurriculumProgress(age),
  };
  await setDoc(doc(db, "users", uid), { ...profile, createdAt: serverTimestamp() });

  currentUid = uid;
  currentProfile = profile;
  enterGame(profile);
}

async function logIn(name, password) {
  const key = usernameKey(name);
  const usernameSnap = await getDoc(doc(db, "usernames", key));
  if (!usernameSnap.exists()) throw new Error("משתמש לא נמצא");
  await signInWithEmailAndPassword(auth, usernameSnap.data().email, password);
}

// Older accounts (from before the age/tier curriculum existed) have
// no currentTier/activePool yet - back-fill them once, on first load
// after this update, instead of breaking on missing fields forever.
async function loadProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) return null;
  const profile = snap.data();
  if (!profile.currentTier || !profile.activePool) {
    const progress = initialCurriculumProgress(profile.age);
    Object.assign(profile, progress);
    if (!profile.masteredWords) profile.masteredWords = [];
    await setDoc(doc(db, "users", uid), progress, { merge: true }).catch((err) =>
      console.error("Failed to migrate profile to curriculum tiers", err)
    );
  }
  return profile;
}

function todayKey() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function recordAnswer(uid, isCorrect, answerMode) {
  updateDoc(doc(db, "users", uid), {
    totalCorrect: increment(isCorrect ? 1 : 0),
    totalWrong: increment(isCorrect ? 0 : 1),
  }).catch((err) => console.error("Failed to sync stats", err));

  const modeKey = answerMode === "choice" ? "choice" : answerMode;
  setDoc(
    doc(db, "users", uid, "dailyStats", todayKey()),
    {
      correct: increment(isCorrect ? 1 : 0),
      wrong: increment(isCorrect ? 0 : 1),
      byMode: {
        [modeKey]: { correct: increment(isCorrect ? 1 : 0), wrong: increment(isCorrect ? 0 : 1) },
      },
    },
    { merge: true }
  ).catch((err) => console.error("Failed to sync daily stats", err));
}

function recordQuizCompleted(uid) {
  setDoc(
    doc(db, "users", uid, "dailyStats", todayKey()),
    { quizzes: increment(1) },
    { merge: true }
  ).catch((err) => console.error("Failed to sync quiz count", err));
}

// ---- Auth UI wiring ----

const authEls = {
  screen: document.getElementById("authScreen"),
  tabLogin: document.getElementById("tabLogin"),
  tabSignup: document.getElementById("tabSignup"),
  tabGuest: document.getElementById("tabGuest"),
  loginForm: document.getElementById("loginForm"),
  signupForm: document.getElementById("signupForm"),
  guestForm: document.getElementById("guestForm"),
  loginName: document.getElementById("loginName"),
  loginPassword: document.getElementById("loginPassword"),
  signupName: document.getElementById("signupName"),
  signupAge: document.getElementById("signupAge"),
  signupPassword: document.getElementById("signupPassword"),
  signupConfirm: document.getElementById("signupConfirm"),
  guestAge: document.getElementById("guestAge"),
  error: document.getElementById("authError"),
  loading: document.getElementById("authLoading"),
  userBar: document.getElementById("userBar"),
  gameStats: document.getElementById("gameStats"),
  userGreeting: document.getElementById("userGreeting"),
  userLevelBadge: document.getElementById("userLevelBadge"),
  logoutBtn: document.getElementById("logoutBtn"),
};

function setAuthError(message) {
  authEls.error.textContent = message || "";
}

function setAuthLoading(isLoading) {
  authEls.loading.classList.toggle("hidden", !isLoading);
}

const authTabs = [
  { tab: authEls.tabLogin, form: authEls.loginForm },
  { tab: authEls.tabSignup, form: authEls.signupForm },
  { tab: authEls.tabGuest, form: authEls.guestForm },
];

function activateAuthTab(activeTab) {
  authTabs.forEach(({ tab, form }) => {
    const isActive = tab === activeTab;
    tab.classList.toggle("active", isActive);
    form.classList.toggle("hidden", !isActive);
  });
  setAuthError("");
}

authEls.tabLogin.addEventListener("click", () => activateAuthTab(authEls.tabLogin));
authEls.tabSignup.addEventListener("click", () => activateAuthTab(authEls.tabSignup));
authEls.tabGuest.addEventListener("click", () => activateAuthTab(authEls.tabGuest));

authEls.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setAuthError("");
  setAuthLoading(true);
  try {
    await logIn(authEls.loginName.value, authEls.loginPassword.value);
  } catch (err) {
    setAuthError(loginErrorMessage(err));
  } finally {
    setAuthLoading(false);
  }
});

authEls.signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setAuthError("");

  const name = authEls.signupName.value;
  const age = Number(authEls.signupAge.value);
  const password = authEls.signupPassword.value;
  const confirm = authEls.signupConfirm.value;

  if (password !== confirm) {
    setAuthError("הסיסמאות לא תואמות");
    return;
  }
  if (password.length < 6) {
    setAuthError("הסיסמה חייבת לפחות 6 תווים");
    return;
  }

  signingUp = true;
  setAuthLoading(true);
  try {
    await signUp(name, age, password);
  } catch (err) {
    setAuthError(signupErrorMessage(err));
  } finally {
    setAuthLoading(false);
    signingUp = false;
  }
});

authEls.guestForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setAuthError("");

  const age = Number(authEls.guestAge.value);

  signingUp = true;
  setAuthLoading(true);
  try {
    await signUpGuest(age);
  } catch (err) {
    console.error("Guest sign-in failed", err);
    setAuthError(`שגיאה (${err.code || "?"}): ${err.message || err}`);
  } finally {
    setAuthLoading(false);
    signingUp = false;
  }
});

authEls.logoutBtn.addEventListener("click", () => signOut(auth));

function loginErrorMessage(err) {
  if (err.message === "משתמש לא נמצא") return err.message;
  if (err.code === "auth/wrong-password" || err.code === "auth/invalid-credential") {
    return "סיסמה שגויה";
  }
  return "משהו השתבש, נסה שוב";
}

function signupErrorMessage(err) {
  if (err.message && !err.code) return err.message;
  if (err.code === "auth/weak-password") return "הסיסמה חייבת לפחות 6 תווים";
  return "משהו השתבש, נסה שוב";
}

let currentUid = null;
let currentProfile = null;

onAuthStateChanged(auth, async (user) => {
  if (signingUp) return;

  if (user) {
    if (user.uid === currentUid) return;
    setAuthLoading(true);
    try {
      const profile = await loadProfile(user.uid);
      if (!profile) {
        await signOut(auth);
        return;
      }
      currentUid = user.uid;
      currentProfile = profile;
      enterGame(profile);
    } catch (err) {
      console.error(err);
      setAuthError("משהו השתבש, נסה שוב");
    } finally {
      setAuthLoading(false);
    }
  } else {
    currentUid = null;
    currentProfile = null;
    showScreen("auth");
    authEls.userBar.classList.add("hidden");
    authEls.gameStats.classList.add("hidden");
  }
});

function levelBadgeText() {
  if (!currentProfile) return "";
  const { age, subLevel } = ageAndSubLevelForTier(currentProfile.currentTier);
  return `גיל ${age} · שלב ${subLevel}`;
}

function enterGame(profile) {
  authEls.userBar.classList.remove("hidden");
  authEls.gameStats.classList.remove("hidden");
  authEls.userGreeting.textContent = `היי ${profile.name}!`;
  authEls.userLevelBadge.textContent = levelBadgeText();
  showScreen("mode");
  renderMyStats();
}

function renderDayChip(day) {
  const chip = document.createElement("div");
  chip.className = "day-chip";
  const dateEl = document.createElement("span");
  dateEl.className = "day-date";
  dateEl.textContent = day.date;
  const statsEl = document.createElement("span");
  statsEl.className = "day-stats";
  statsEl.textContent = `${day.quizzes || 0} חידונים · ${day.correct || 0} נכונות`;
  chip.append(dateEl, statsEl);

  const byMode = day.byMode || {};
  const choiceCorrect = byMode.choice?.correct || 0;
  const typeChoiceCorrect = byMode.typeChoice?.correct || 0;
  const typeCorrect = byMode.type?.correct || 0;
  if (choiceCorrect || typeChoiceCorrect || typeCorrect) {
    const modesEl = document.createElement("span");
    modesEl.className = "day-modes";
    modesEl.textContent = `בחירה: ${choiceCorrect} · בחירה+הקלדה: ${typeChoiceCorrect} · הקלדה: ${typeCorrect}`;
    chip.appendChild(modesEl);
  }
  return chip;
}

async function renderMyStats() {
  if (!currentUid) return;
  gameEls.myStats.classList.remove("hidden");
  gameEls.myStatsDays.innerHTML = "";
  try {
    const dailySnap = await getDocs(
      query(collection(db, "users", currentUid, "dailyStats"), orderBy(documentId(), "desc"), limit(7))
    );
    if (dailySnap.docs.length === 0) {
      const empty = document.createElement("span");
      empty.className = "no-data";
      empty.textContent = "אין נתונים עדיין, שחקו כדי להתחיל!";
      gameEls.myStatsDays.appendChild(empty);
    } else {
      dailySnap.docs.forEach((d) => {
        gameEls.myStatsDays.appendChild(renderDayChip({ date: d.id, ...d.data() }));
      });
    }
  } catch (err) {
    console.error("Failed to load daily stats", err);
    const errorEl = document.createElement("span");
    errorEl.className = "no-data";
    errorEl.style.whiteSpace = "pre-wrap";
    errorEl.style.wordBreak = "break-all";
    errorEl.textContent = `שגיאה בטעינת הנתונים (${err.code || "?"}): ${err.message || err}`;
    gameEls.myStatsDays.appendChild(errorEl);
  }
}

// ---- Screen navigation ----

const gameEls = {
  score: document.getElementById("score"),
  streak: document.getElementById("streak"),
  prompt: document.getElementById("prompt"),
  modeBackBtn: document.getElementById("modeBackBtn"),
  hintBtn: document.getElementById("hintBtn"),
  hintReveal: document.getElementById("hintReveal"),
  typeChoiceHint: document.getElementById("typeChoiceHint"),
  options: document.getElementById("options"),
  typeAnswer: document.getElementById("typeAnswer"),
  typeInput: document.getElementById("typeInput"),
  tapKeyboard: document.getElementById("tapKeyboard"),
  typeBackspace: document.getElementById("typeBackspace"),
  typeCheck: document.getElementById("typeCheck"),
  feedback: document.getElementById("feedback"),
  nextBtn: document.getElementById("nextBtn"),
  skipBtn: document.getElementById("skipBtn"),
  game: document.getElementById("game"),
  celebration: document.getElementById("celebration"),
  celebrationScore: document.getElementById("celebrationScore"),
  confettiLayer: document.getElementById("confettiLayer"),
  playAgainBtn: document.getElementById("playAgainBtn"),
  switchModeBtn: document.getElementById("switchModeBtn"),
  modeScreen: document.getElementById("modeScreen"),
  modeContinuousBtn: document.getElementById("modeContinuousBtn"),
  modeSprintBtn: document.getElementById("modeSprintBtn"),
  modePhotoBtn: document.getElementById("modePhotoBtn"),
  photoInput: document.getElementById("photoInput"),
  photoStatus: document.getElementById("photoStatus"),
  myStats: document.getElementById("myStats"),
  myStatsDays: document.getElementById("myStatsDays"),
  photoConfigScreen: document.getElementById("photoConfigScreen"),
  cfgPhotoKeyboard: document.getElementById("cfgPhotoKeyboard"),
  photoConfigStartBtn: document.getElementById("photoConfigStartBtn"),
  photoWordsScreen: document.getElementById("photoWordsScreen"),
  photoWordsList: document.getElementById("photoWordsList"),
  photoWordAddEn: document.getElementById("photoWordAddEn"),
  photoWordAddHe: document.getElementById("photoWordAddHe"),
  photoWordAddBtn: document.getElementById("photoWordAddBtn"),
  photoWordsError: document.getElementById("photoWordsError"),
  photoWordsContinueBtn: document.getElementById("photoWordsContinueBtn"),
  continuousConfigScreen: document.getElementById("continuousConfigScreen"),
  cfgEnHe: document.getElementById("cfgEnHe"),
  cfgHeEn: document.getElementById("cfgHeEn"),
  cfgPictures: document.getElementById("cfgPictures"),
  continuousConfigError: document.getElementById("continuousConfigError"),
  continuousConfigStartBtn: document.getElementById("continuousConfigStartBtn"),
};

const screens = {
  auth: authEls.screen,
  mode: gameEls.modeScreen,
  continuousConfig: gameEls.continuousConfigScreen,
  photoWords: gameEls.photoWordsScreen,
  photoConfig: gameEls.photoConfigScreen,
  game: gameEls.game,
  celebration: gameEls.celebration,
};

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.classList.toggle("hidden", key !== name);
  });
}

// ---- Game engine shared by all three modes ----

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

const SPRINT_WORD_COUNT = 10;
const SPRINT_STAGES = MASTERY_STAGES; // same 3-stage progression the curriculum pool uses

let currentMode = "continuous"; // "continuous" | "sprint" | "photo"
let score = 0;
let streak = 0;
let round = 0;
let advanceTimer = null;
let lastWordEn = null;
let locked = false;

// Photo mode: the word list/round shape/answer method are all fixed
// by the picker screen rather than chosen randomly each round.
let activeWords = null;
let activeRoundTypes = null;
let forcedAnswerMode = null;
let pendingPhotoWords = null;

// Continuous mode: which round shapes and answer methods the kid
// picked on the settings screen. "choice" always stays available so
// there's always an answerable mode even if keyboard is unchecked.
let continuousAllowedAnswerModes = ["choice", "typeChoice", "type"];

function buildContinuousRoundTypes(config) {
  const types = [];
  if (config.enHe) types.push({ prompt: "en", options: "he" });
  if (config.heEn) types.push({ prompt: "he", options: "en" });
  if (config.pictures) {
    types.push({ prompt: "emoji", options: "en" });
    types.push({ prompt: "en", options: "emoji" });
  }
  return types;
}

// Sprint mode: 10 words, each tracked through 3 mastery stages.
let sprintWords = [];

// The round currently on screen — read by the hint button and by the
// answer-checking functions, set once per round by renderRound().
let currentCorrectWord = null;
let currentRoundType = null;
let currentAnswerMode = null;
let currentCorrectKey = null;
let hintUsedThisRound = false;

function optionKey(word, kind) {
  return kind === "he" ? word.he : kind === "en" ? word.en : word.emoji;
}

function answerLanguage(roundType) {
  return roundType.options === "he" ? "he" : "en";
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
  gameEls.prompt.className = `prompt kind-${kind}`;
  gameEls.prompt.textContent = optionKey(word, kind);
}

function renderOption(word, kind) {
  const btn = document.createElement("button");
  btn.className = "option-btn" + (kind === "en" ? " lang-en" : kind === "emoji" ? " emoji-option" : "");
  btn.textContent = optionKey(word, kind);
  btn.dataset.key = optionKey(word, kind);
  return btn;
}

function eligibleWords() {
  if (!currentProfile) return window.WORDS;
  const pool = window.WORDS.filter((w) => w.tier <= currentProfile.currentTier);
  return pool.length >= 3 ? pool : window.WORDS;
}

function currentPool() {
  return activeWords || eligibleWords();
}

// Used by photo mode only (continuous mode derives its answer mode
// from each word's personal curriculum stage instead). A typed
// answer isn't offered when the target is a picture (there's nothing
// to spell), and only from the methods enabled on the settings
// screen. Multiple-choice always stays available.
function pickAnswerMode(roundType) {
  const allowed =
    roundType.options === "emoji"
      ? ["choice"]
      : continuousAllowedAnswerModes;
  return allowed[Math.floor(Math.random() * allowed.length)];
}

function hideAllAnswerModes() {
  gameEls.options.classList.add("hidden");
  gameEls.typeChoiceHint.classList.add("hidden");
  gameEls.typeAnswer.classList.add("hidden");
}

function renderOptionButtons(correctWord, roundType, interactive) {
  const sourcePool = currentPool();
  const wrongPool = sourcePool.filter((w) => optionKey(w, roundType.options) !== currentCorrectKey);
  const optionWords = shuffle([correctWord, ...pickRandom(wrongPool, 2)]);
  gameEls.options.innerHTML = "";
  gameEls.options.classList.toggle("options-compact", !interactive);
  optionWords.forEach((word) => {
    const btn = renderOption(word, roundType.options);
    if (interactive) {
      btn.addEventListener("click", () => selectOption(btn, word));
    } else {
      btn.disabled = true;
    }
    gameEls.options.appendChild(btn);
  });
}

function showTypedInput(roundType) {
  const lang = answerLanguage(roundType);
  gameEls.typeInput.dir = lang === "he" ? "rtl" : "ltr";
  gameEls.typeInput.placeholder = lang === "he" ? "הקלד בעברית" : "הקלד באנגלית";
  gameEls.typeAnswer.classList.remove("hidden");
  buildTapKeyboard(lang);
  gameEls.skipBtn.classList.remove("hidden");
}

function resetTypeInput() {
  gameEls.typeInput.value = "";
  gameEls.typeInput.disabled = false;
  gameEls.typeInput.classList.remove("correct", "wrong");
}


function renderRound(correctWord, roundType, answerMode) {
  currentCorrectWord = correctWord;
  currentRoundType = roundType;
  currentAnswerMode = answerMode;
  currentCorrectKey = optionKey(correctWord, roundType.options);
  hintUsedThisRound = false;
  gameEls.hintBtn.disabled = false;
  gameEls.hintReveal.classList.add("hidden");
  gameEls.hintReveal.textContent = "";

  locked = false;
  gameEls.feedback.textContent = "";
  gameEls.feedback.className = "feedback";
  gameEls.skipBtn.classList.add("hidden");
  hideAllAnswerModes();
  resetTypeInput();

  renderPrompt(correctWord, roundType.prompt);

  if (answerMode === "choice") {
    gameEls.options.classList.remove("hidden");
    renderOptionButtons(correctWord, roundType, true);
  } else if (answerMode === "typeChoice") {
    gameEls.options.classList.remove("hidden");
    gameEls.typeChoiceHint.classList.remove("hidden");
    renderOptionButtons(correctWord, roundType, false);
    showTypedInput(roundType);
  } else {
    showTypedInput(roundType);
  }
}

// ---- Mode: continuous ----

function startSession() {
  score = 0;
  streak = 0;
  round = 0;
  lastWordEn = null;
  gameEls.score.textContent = "0";
  gameEls.streak.textContent = "0";
  nextRound();
}

// ---- Mode: sprint ----

function startSprintSession() {
  const pool = eligibleWords();
  const chosen = pickRandom(pool, Math.min(SPRINT_WORD_COUNT, pool.length));
  sprintWords = chosen.map((word) => ({ word, stage: 0 }));

  score = 0;
  streak = 0;
  lastWordEn = null;
  gameEls.score.textContent = "0";
  gameEls.streak.textContent = "0";
  nextRound();
}

function allSprintWordsMastered() {
  return sprintWords.every((entry) => entry.stage >= SPRINT_STAGES.length);
}

function pickSprintRound() {
  const remaining = sprintWords.filter((entry) => entry.stage < SPRINT_STAGES.length);
  const entry = remaining[Math.floor(Math.random() * remaining.length)];
  const answerMode = SPRINT_STAGES[entry.stage];
  const roundType = { prompt: Math.random() < 0.5 ? "he" : "emoji", options: "en" };
  return { correctWord: entry.word, roundType, answerMode };
}

function advanceSprintWord(word, succeeded) {
  const entry = sprintWords.find((e) => e.word === word);
  if (entry && succeeded) entry.stage += 1;
}

// ---- Round dispatch ----

function nextRound() {
  clearTimeout(advanceTimer);
  gameEls.nextBtn.classList.add("hidden");

  if (currentMode === "sprint") {
    if (allSprintWordsMastered()) {
      showCelebration();
      return;
    }
    const { correctWord, roundType, answerMode } = pickSprintRound();
    renderRound(correctWord, roundType, answerMode);
    return;
  }

  round += 1;
  if (round > ROUNDS_PER_SESSION) {
    showCelebration();
    return;
  }

  if (currentMode === "continuous") {
    const { correctWord, roundType, answerMode } = pickContinuousRound();
    lastWordEn = correctWord.en;
    renderRound(correctWord, roundType, answerMode);
    return;
  }

  // Photo mode: a fixed word list picked by the user, answered
  // however the settings screen allows (unrelated to the personal
  // curriculum pool above).
  const pool = currentPool();
  let correctWord;
  do {
    correctWord = pool[Math.floor(Math.random() * pool.length)];
  } while (correctWord.en === lastWordEn && pool.length > 1);
  lastWordEn = correctWord.en;

  const types = activeRoundTypes || ROUND_TYPES;
  const roundType = types[Math.floor(Math.random() * types.length)];
  const answerMode = forcedAnswerMode || pickAnswerMode(roundType);

  renderRound(correctWord, roundType, answerMode);
}

// Continuous mode's word comes from the kid's personal active pool
// (not a flat random pick), and the answer mode is whatever mastery
// stage that specific word is currently at - so the same word always
// shows the same way until it's answered correctly and advances.
function pickContinuousRound() {
  const progress = currentProfile;
  let poolEntry = null;
  if (progress?.activePool?.length > 0) {
    poolEntry = progress.activePool[Math.floor(Math.random() * progress.activePool.length)];
  }
  let correctWord = poolEntry ? window.WORDS.find((w) => w.en === poolEntry.en) : null;
  let answerMode = "choice";
  if (correctWord) {
    answerMode = MASTERY_STAGES[Math.min(poolEntry.stage, MASTERY_STAGES.length - 1)];
  } else {
    // The personal pool is empty (e.g. curriculum content ran out) -
    // fall back to the broader unlocked pool so play never breaks.
    const fallbackPool = eligibleWords();
    correctWord = fallbackPool[Math.floor(Math.random() * fallbackPool.length)];
  }

  const candidateTypes = (activeRoundTypes || ROUND_TYPES).filter((rt) => {
    if ((rt.prompt === "emoji" || rt.options === "emoji") && !correctWord.emoji) return false;
    if (answerMode !== "choice" && rt.options === "emoji") return false;
    return true;
  });
  const roundType =
    candidateTypes[Math.floor(Math.random() * candidateTypes.length)] || { prompt: "en", options: "he" };

  return { correctWord, roundType, answerMode };
}

// ---- Finishing a round: scoring, mistake explanations, hint penalty ----

function describeMistake(detail) {
  const correct = currentCorrectWord;
  const kind = currentRoundType.options;

  if (detail.chosenWord) {
    const chosen = detail.chosenWord;
    if (kind === "he") {
      return `לא נכון. '${chosen.he}' זה '${chosen.en}', אבל המילה המבוקשת היא '${correct.en}' שזה '${correct.he}'.`;
    }
    if (kind === "en") {
      return `לא נכון. '${chosen.en}' זה '${chosen.he}', אבל המילה המבוקשת היא '${correct.he}' וזה '${correct.en}'.`;
    }
    return `לא נכון. בחרת בתמונה של '${chosen.en}' (${chosen.he}), אבל המילה הנכונה היא '${correct.en}' (${correct.he}).`;
  }

  if (typeof detail.typedValue === "string") {
    return `כתבת '${detail.typedValue}', אבל התשובה הנכונה היא '${currentCorrectKey}'.`;
  }

  return `לא נכון, התשובה היא '${currentCorrectKey}'`;
}

function finishRound(isCorrect, detail) {
  // A hint makes the round easier, so a correct answer after using one
  // doesn't count toward score, level, daily stats, or sprint progress.
  const outcome = !isCorrect ? "wrong" : hintUsedThisRound ? "hinted" : "correct";

  if (outcome === "correct") {
    score += 1;
    streak += 1;
    gameEls.feedback.textContent = "יפה מאוד! 🎉";
    gameEls.feedback.className = "feedback show correct";
  } else if (outcome === "hinted") {
    streak = 0;
    gameEls.feedback.textContent = "נכון! אבל זה לא נספר כי השתמשת ברמז 💡";
    gameEls.feedback.className = "feedback show correct";
  } else {
    streak = 0;
    gameEls.feedback.textContent = describeMistake(detail);
    gameEls.feedback.className = "feedback show wrong";
  }

  gameEls.score.textContent = score;
  gameEls.streak.textContent = streak;

  if (outcome !== "wrong") {
    speakWord(currentCorrectWord.en);
  }

  if (currentProfile && outcome !== "hinted") {
    const countedCorrect = outcome === "correct";
    currentProfile.totalCorrect += countedCorrect ? 1 : 0;
    currentProfile.totalWrong += countedCorrect ? 0 : 1;
    if (currentMode === "continuous" && countedCorrect) {
      advanceWordProgress(currentCorrectWord.en);
    }
    authEls.userLevelBadge.textContent = levelBadgeText();
    recordAnswer(currentUid, countedCorrect, currentAnswerMode);
  }

  if (currentMode === "sprint") {
    advanceSprintWord(currentCorrectWord, outcome === "correct");
  }

  // A wrong answer waits for the kid to tap "next" so there's time to
  // actually read the mistake explanation; a correct one auto-advances.
  if (outcome === "wrong") {
    gameEls.nextBtn.classList.remove("hidden");
  } else {
    advanceTimer = setTimeout(nextRound, CORRECT_ADVANCE_DELAY);
  }
}

// Advances one word's personal mastery stage after a correct answer.
// Clearing the last stage ("type") masters it, pulling in a
// replacement from the next tier and persisting the whole pool.
function advanceWordProgress(en) {
  const progress = currentProfile;
  if (!progress?.activePool) return;
  const entry = progress.activePool.find((e) => e.en === en);
  if (!entry) return; // came from the eligibleWords() fallback, not the pool itself

  entry.stage += 1;
  if (entry.stage >= MASTERY_STAGES.length) {
    masterCurriculumWord(en);
  }
  persistCurriculumProgress();
}

function masterCurriculumWord(en) {
  const progress = currentProfile;
  progress.activePool = progress.activePool.filter((e) => e.en !== en);
  progress.masteredWords = [...(progress.masteredWords || []), en];

  const nextTier = progress.currentTier + 1;
  const replacement = pickCurriculumWord(progress, nextTier);
  if (replacement) {
    progress.activePool.push({ en: replacement.en, stage: 0 });
    progress.seenWords = [...progress.seenWords, replacement.en];
  }

  // Once most of the pool has drifted into next-tier words, the
  // whole tier advances - the pool keeps whatever it already has
  // rather than resetting, so the climb stays continuous.
  if (progress.currentTier < MAX_TIER && progress.activePool.length > 0) {
    const nextTierCount = progress.activePool.filter((e) => wordTierOf(e.en) === nextTier).length;
    if (nextTierCount > progress.activePool.length / 2) {
      progress.currentTier = nextTier;
    }
  }
}

function persistCurriculumProgress() {
  if (!currentUid || !currentProfile) return;
  updateDoc(doc(db, "users", currentUid), {
    currentTier: currentProfile.currentTier,
    activePool: currentProfile.activePool,
    seenWords: currentProfile.seenWords,
    masteredWords: currentProfile.masteredWords,
  }).catch((err) => console.error("Failed to sync curriculum progress", err));
}

// Lets a kid opt out of a typed round entirely (typing can be tedious
// for a young kid) with no penalty at all — score, streak, level, and
// sprint progress are all left untouched, it just moves on.
function skipRound() {
  if (locked) return;
  locked = true;
  gameEls.skipBtn.classList.add("hidden");
  gameEls.feedback.textContent = "דילגת על השאלה";
  gameEls.feedback.className = "feedback show";
  advanceTimer = setTimeout(nextRound, CORRECT_ADVANCE_DELAY);
}

function selectOption(button, word) {
  if (locked) return;
  locked = true;

  const buttons = [...gameEls.options.children];
  const chosenKey = optionKey(word, currentRoundType.options);
  const isCorrect = chosenKey === currentCorrectKey;
  button.classList.add(isCorrect ? "correct" : "wrong");
  if (!isCorrect) buttons.find((b) => b.dataset.key === currentCorrectKey)?.classList.add("correct");
  buttons.forEach((b) => (b.disabled = true));

  finishRound(isCorrect, { chosenWord: word });
}

function checkTypedAnswer() {
  if (locked) return;
  const value = gameEls.typeInput.value.trim().toLowerCase();
  if (!value) return;
  locked = true;

  const isCorrect = value === currentCorrectKey.toLowerCase();
  gameEls.typeInput.classList.add(isCorrect ? "correct" : "wrong");
  gameEls.typeInput.disabled = true;

  finishRound(isCorrect, { typedValue: value });
}

function showCelebration() {
  showScreen("celebration");
  gameEls.celebrationScore.textContent =
    currentMode === "sprint" ? `10 מילים הושלמו! ⭐ ${score}` : `${score} מתוך ${ROUNDS_PER_SESSION}`;

  if (currentUid) recordQuizCompleted(currentUid);

  gameEls.confettiLayer.innerHTML = "";
  for (let i = 0; i < 18; i++) {
    const piece = document.createElement("span");
    piece.className = "confetti";
    piece.textContent = CONFETTI_EMOJI[Math.floor(Math.random() * CONFETTI_EMOJI.length)];
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.animationDelay = `${Math.random() * 2}s`;
    piece.style.animationDuration = `${2.6 + Math.random() * 1.6}s`;
    gameEls.confettiLayer.appendChild(piece);
  }
}

gameEls.playAgainBtn.addEventListener("click", () => {
  showScreen("game");
  if (currentMode === "sprint") startSprintSession();
  else startSession();
});

function goToModeSelect() {
  clearTimeout(advanceTimer);
  activeWords = null;
  activeRoundTypes = null;
  forcedAnswerMode = null;
  showScreen("mode");
  renderMyStats();
}

gameEls.switchModeBtn.addEventListener("click", goToModeSelect);
gameEls.modeBackBtn.addEventListener("click", goToModeSelect);

gameEls.nextBtn.addEventListener("click", nextRound);
gameEls.skipBtn.addEventListener("click", skipRound);

// ---- Mode picker ----

gameEls.modeContinuousBtn.addEventListener("click", () => {
  gameEls.continuousConfigError.textContent = "";
  showScreen("continuousConfig");
});

gameEls.continuousConfigStartBtn.addEventListener("click", () => {
  const config = {
    enHe: gameEls.cfgEnHe.checked,
    heEn: gameEls.cfgHeEn.checked,
    pictures: gameEls.cfgPictures.checked,
  };
  const types = buildContinuousRoundTypes(config);
  if (types.length === 0) {
    gameEls.continuousConfigError.textContent = "בחר לפחות אפשרות אחת בכיוון ותוכן";
    return;
  }

  currentMode = "continuous";
  activeWords = null;
  activeRoundTypes = types;
  forcedAnswerMode = null;

  showScreen("game");
  startSession();
});

gameEls.modeSprintBtn.addEventListener("click", () => {
  currentMode = "sprint";
  activeWords = null;
  activeRoundTypes = null;
  forcedAnswerMode = null;
  showScreen("game");
  startSprintSession();
});

gameEls.modePhotoBtn.addEventListener("click", () => gameEls.photoInput.click());

// ---- Hint (elimination / reveal-to-copy / pronunciation) ----

function speakWord(text) {
  if (!window.speechSynthesis) return;
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  } catch (err) {
    console.error("Speech synthesis failed", err);
  }
}

function useHint() {
  if (hintUsedThisRound || locked) return;
  hintUsedThisRound = true;
  gameEls.hintBtn.disabled = true;

  speakWord(currentCorrectWord.en);

  if (currentAnswerMode === "choice" || currentAnswerMode === "typeChoice") {
    const wrongButtons = [...gameEls.options.children].filter(
      (b) => b.dataset.key !== currentCorrectKey && !b.classList.contains("eliminated")
    );
    const pick = wrongButtons[Math.floor(Math.random() * wrongButtons.length)];
    if (pick) {
      pick.disabled = true;
      pick.classList.add("eliminated");
    }
  } else {
    gameEls.hintReveal.dir = answerLanguage(currentRoundType) === "he" ? "rtl" : "ltr";
    gameEls.hintReveal.textContent = currentCorrectKey;
    gameEls.hintReveal.classList.remove("hidden");
  }
}

gameEls.hintBtn.addEventListener("click", useHint);

// ---- Typed answer (on-screen keyboard only, device keyboard suppressed) ----

const KEYBOARD_LAYOUTS = {
  en: ["qwertyuiop", "asdfghjkl", "zxcvbnm"],
  he: ["אבגדהוז", "חטיכךלמ", "םנןסעפף", "צץקרשת"],
};

function buildTapKeyboard(lang) {
  gameEls.tapKeyboard.innerHTML = "";
  gameEls.tapKeyboard.dir = lang === "he" ? "rtl" : "ltr";
  KEYBOARD_LAYOUTS[lang].forEach((row) => {
    [...row].forEach((letter) => {
      const key = document.createElement("button");
      key.type = "button";
      key.className = "tap-key";
      key.textContent = letter;
      key.addEventListener("click", () => {
        gameEls.typeInput.value += letter;
      });
      gameEls.tapKeyboard.appendChild(key);
    });
  });
}

gameEls.typeBackspace.addEventListener("click", () => {
  gameEls.typeInput.value = gameEls.typeInput.value.slice(0, -1);
});

gameEls.typeCheck.addEventListener("click", checkTypedAnswer);

// ---- Photo training: read a page, quiz only on its words ----

gameEls.photoInput.addEventListener("change", async () => {
  const file = gameEls.photoInput.files[0];
  gameEls.photoInput.value = "";
  if (file) await resolvePhotoWords(file);
});

function setPhotoStatus(text, isError) {
  if (!text) {
    gameEls.photoStatus.classList.add("hidden");
    return;
  }
  gameEls.photoStatus.textContent = text;
  gameEls.photoStatus.classList.remove("hidden");
  gameEls.photoStatus.classList.toggle("error", Boolean(isError));
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      resolve(img);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// Otsu's method: picks the gray-level threshold that best splits the
// image into two classes (ink vs. paper) by maximizing the variance
// between them. When several thresholds tie for the max (a perfectly
// flat run with no pixels in between, e.g. clean printed text), the
// midpoint of that run is used rather than its first or last edge.
function otsuThreshold(gray) {
  const histogram = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) histogram[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];

  let sumB = 0;
  let wB = 0;
  let maxBetween = -1;
  let firstMax = 127;
  let lastMax = 127;
  for (let i = 0; i < 256; i++) {
    wB += histogram[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * histogram[i];
    const meanB = sumB / wB;
    const meanF = (sum - sumB) / wF;
    const between = wB * wF * (meanB - meanF) * (meanB - meanF);
    if (between > maxBetween) {
      maxBetween = between;
      firstMax = i;
      lastMax = i;
    } else if (between === maxBetween) {
      lastMax = i;
    }
  }
  return Math.round((firstMax + lastMax) / 2);
}

// Photographed pages are rarely OCR-friendly straight out of the
// camera: uneven lighting, shadows, and low contrast all confuse
// Tesseract. Upscaling small photos and converting to a clean
// black-on-white image (grayscale + Otsu binarization) mirrors the
// preprocessing a real document scanner would do, without touching
// Tesseract's own recognition settings.
async function preprocessPhotoForOcr(file) {
  let img;
  try {
    img = await loadImageFromFile(file);
  } catch (err) {
    return file;
  }

  const MIN_WIDTH = 1400;
  const scale = img.width < MIN_WIDTH ? MIN_WIDTH / img.width : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const gray = new Uint8ClampedArray(data.length / 4);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  const threshold = otsuThreshold(gray);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const v = gray[j] >= threshold ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = v;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Free, no-signup translation endpoint (MyMemory) — good enough for
// single common words, no billing/account setup required. Quality can
// be uneven for uncommon words since it's a community-run service,
// and rapid back-to-back requests can get rate-limited — one retry
// after a short pause recovers most of those instead of just
// silently dropping the word.
async function translateWord(word, attempt = 0) {
  try {
    const res = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=en|he`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const translated = data?.responseData?.translatedText;
    if (!translated || translated.toLowerCase() === word.toLowerCase()) return null;
    return translated;
  } catch (err) {
    if (attempt < 1) {
      await sleep(700);
      return translateWord(word, attempt + 1);
    }
    console.error("Translation failed", err);
    return null;
  }
}

async function resolvePhotoWords(file) {
  setPhotoStatus("קורא את התמונה...");
  let text = "";
  try {
    const ocrInput = await preprocessPhotoForOcr(file);
    const result = await window.Tesseract.recognize(ocrInput, "eng");
    text = result.data.text || "";
  } catch (err) {
    console.error("Photo OCR failed", err);
    setPhotoStatus("לא הצלחתי לקרוא את התמונה, נסה תמונה ברורה יותר", true);
    return;
  }

  const candidates = [...new Set((text.match(/[A-Za-z]{2,}/g) || []).map((w) => w.toLowerCase()))].slice(0, 40);
  if (candidates.length === 0) {
    setPhotoStatus("לא נמצאו מילים באנגלית בתמונה", true);
    return;
  }

  const resolved = [];
  for (let i = 0; i < candidates.length; i++) {
    const word = candidates[i];
    setPhotoStatus(`מתרגם מילים... (${i + 1}/${candidates.length})`);
    const known = window.WORDS.find((w) => w.en === word);
    if (known) {
      resolved.push(known);
      continue;
    }
    const he = await translateWord(word);
    if (he) resolved.push({ en: word, he, emoji: null });
    // A small pause between real network calls avoids tripping the
    // free translation API's rate limit, which was silently dropping
    // most words past the first handful.
    await sleep(200);
  }

  if (resolved.length < 3) {
    setPhotoStatus("לא הצלחתי למצוא מספיק מילים בתמונה, נסה תמונה אחרת", true);
    return;
  }

  pendingPhotoWords = resolved;
  setPhotoStatus("");
  renderPhotoWordsChecklist();
  showScreen("photoWords");
}

function buildPhotoWordRow(word) {
  const row = document.createElement("div");
  row.className = "photo-word-choice";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = true;

  const enInput = document.createElement("input");
  enInput.type = "text";
  enInput.className = "photo-word-en-input";
  enInput.autocomplete = "off";
  enInput.autocapitalize = "off";
  enInput.spellcheck = false;
  enInput.value = word.en;

  const heInput = document.createElement("input");
  heInput.type = "text";
  heInput.className = "photo-word-he-input";
  heInput.autocomplete = "off";
  heInput.spellcheck = false;
  heInput.value = word.he;

  row.append(checkbox, enInput, heInput);
  return row;
}

function renderPhotoWordsChecklist() {
  gameEls.photoWordsList.innerHTML = "";
  gameEls.photoWordsError.textContent = "";
  pendingPhotoWords.forEach((word) => {
    gameEls.photoWordsList.appendChild(buildPhotoWordRow(word));
  });
}

function addManualPhotoWord() {
  const en = gameEls.photoWordAddEn.value.trim().toLowerCase();
  const he = gameEls.photoWordAddHe.value.trim();
  if (!en || !he) return;
  gameEls.photoWordsList.appendChild(buildPhotoWordRow({ en, he }));
  gameEls.photoWordAddEn.value = "";
  gameEls.photoWordAddHe.value = "";
  gameEls.photoWordAddEn.focus();
}

gameEls.photoWordAddBtn.addEventListener("click", addManualPhotoWord);
[gameEls.photoWordAddEn, gameEls.photoWordAddHe].forEach((input) => {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addManualPhotoWord();
    }
  });
});

gameEls.photoWordsContinueBtn.addEventListener("click", () => {
  const rows = [...gameEls.photoWordsList.querySelectorAll(".photo-word-choice")];
  const checked = rows
    .filter((row) => row.querySelector('input[type="checkbox"]').checked)
    .map((row) => ({
      en: row.querySelector(".photo-word-en-input").value.trim().toLowerCase(),
      he: row.querySelector(".photo-word-he-input").value.trim(),
      emoji: null,
    }))
    .filter((w) => w.en && w.he);

  if (checked.length < 3) {
    gameEls.photoWordsError.textContent = "צריך לפחות 3 מילים מסומנות עם תרגום";
    return;
  }
  pendingPhotoWords = checked;
  showScreen("photoConfig");
});

gameEls.photoConfigStartBtn.addEventListener("click", () => {
  const direction = document.querySelector('input[name="photoDirection"]:checked').value;

  activeWords = pendingPhotoWords;
  activeRoundTypes =
    direction === "he-en" ? [{ prompt: "he", options: "en" }] : [{ prompt: "en", options: "he" }];
  continuousAllowedAnswerModes = ["choice", ...(gameEls.cfgPhotoKeyboard.checked ? ["typeChoice", "type"] : [])];
  forcedAnswerMode = null;
  currentMode = "photo";

  showScreen("game");
  startSession();
});
