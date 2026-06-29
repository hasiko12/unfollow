/**
 * X (Twitter) フォロー解除スクリプト
 *
 * 目的:
 * - block_keywords.txt に一致するユーザーを解除
 * - keep_following.txt にいるユーザーは除外
 * - unfollow_log.csv を使って既に解除済みのユーザーを再処理しない
 *
 * 実行:
 *   node unfollow.js
 */

const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  YOUR_USERNAME: 'gamer_nitii',
  UNFOLLOW_LIMIT: 180,
  DELAY_BETWEEN_UNFOLLOW: 2700,
  DELAY_AFTER_BATCH: 16000,
  BATCH_SIZE: 30,
  LOG_FILE: 'unfollow_log.csv',
  KEEP_FILE: 'keep_following.txt',
  BLOCK_KEYWORDS_FILE: 'block_keywords.txt',
  PROFILE_DIR: path.join(process.cwd(), '.x_chrome_profile'),

  KEYWORD_ONLY_MODE: true,
  UNFOLLOW_MUTUAL: true,
  DEBUG_LOG: false,

  SCROLL_AMOUNT: 180,
  WAIT_AFTER_SCROLL: 2000,
  MAX_STALLED_SCROLLS: 12,
  MAX_RETRY_PER_USER: 3,
  CLICK_TIMEOUT: 7000,
  SCROLL_RETRY_AMOUNTS: [180, 260, 360, 520],
};

const SELECTORS = {
  PRIMARY_COLUMN: '[data-testid="primaryColumn"]',
  USER_CELL: '[data-testid="UserCell"]',
  FOLLOWING_BUTTON: '[data-testid$="-unfollow"]',
  FOLLOWING_BUTTON_CANDIDATES: '[data-testid="primaryColumn"] [data-testid$="-unfollow"]',
  CONFIRM_BUTTONS: [
    '[data-testid="confirmationSheetConfirm"]',
    '[data-testid="unfollow"]',
  ],
  LOGIN_CHECK: '[data-testid="SideNav_AccountSwitcher_Button"]',
  MUTUAL_FOLLOW_BADGE: '[data-testid="userFollowIndicator"]',
};



function randomDelay(baseMs, varianceMs = 500) {
  return baseMs + Math.floor(Math.random() * varianceMs);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function safeWaitForTimeout(page, ms) {
  if (page.isClosed()) return false;
  try {
    await page.waitForTimeout(ms);
    return !page.isClosed();
  } catch {
    return false;
  }
}

function normalizeLine(line) {
  return line.trim().replace(/^\uFEFF/, '');
}

function normalizeSpaces(text) {
  return (text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}



function extractUsernameFromText(text) {
  const normalized = normalizeSpaces(text);
  if (!normalized) return '';

  const lines = normalized.split(/\s+/);
  for (const token of lines) {
    if (!token.startsWith('@')) continue;
    const handle = token.replace(/^@/, '').match(/^[A-Za-z0-9_]{1,15}/);
    if (handle) return handle[0].toLowerCase();
  }

  const fallback = normalized.match(/@([A-Za-z0-9_]{1,15})/);
  return fallback ? fallback[1].toLowerCase() : '';
}

function loadKeepList() {
  if (!fs.existsSync(CONFIG.KEEP_FILE)) {
    console.log(`[INFO] ${CONFIG.KEEP_FILE} が見つかりません。`);
    return new Set();
  }

  const lines = fs.readFileSync(CONFIG.KEEP_FILE, 'utf8')
    .split(/\r?\n/)
    .map(normalizeLine)
    .map(line => line.replace(/^@/, '').toLowerCase())
    .filter(line => line && !line.startsWith('#'));

  console.log(`[INFO] ホワイトリスト: ${lines.length} 人を除外します`);
  return new Set(lines);
}

function loadBlockKeywords() {
  if (!fs.existsSync(CONFIG.BLOCK_KEYWORDS_FILE)) {
    const sample = [
      '# 解除したいキーワードを1行1語で記載',
      '# 例: ポケモンGO',
      'ポケモンGO',
      'ポケGO',
    ].join('\n');
    fs.writeFileSync(CONFIG.BLOCK_KEYWORDS_FILE, sample, 'utf8');
  }

  const lines = fs.readFileSync(CONFIG.BLOCK_KEYWORDS_FILE, 'utf8')
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(line => line && !line.startsWith('#'));

  console.log(`[INFO] ブロックキーワード: ${lines.length} 件`);
  lines.forEach(keyword => console.log(`        → 「${keyword}」`));
  return lines;
}

function matchesBlockKeyword(text, keywords) {
  if (!text || keywords.length === 0) return null;

  for (const keyword of keywords) {
    if (text.includes(keyword)) return keyword;
  }

  const lowerText = text.toLowerCase();
  for (const keyword of keywords) {
    if (lowerText.includes(keyword.toLowerCase())) return keyword;
  }

  return null;
}

function initLog() {
  if (!fs.existsSync(CONFIG.LOG_FILE)) {
    fs.writeFileSync(
      CONFIG.LOG_FILE,
      'timestamp,username,display_name,profile_url,reason,mutual_follow\n',
      'utf8',
    );
  }
}

function appendLog(username, displayName, profileUrl, reason, isMutual) {
  const ts = new Date().toISOString();
  const mutual = isMutual ? 'YES' : 'NO';
  const row = `"${ts}","${username}","${displayName.replace(/"/g, '""')}","${profileUrl}","${reason.replace(/"/g, '""')}","${mutual}"\n`;
  fs.appendFileSync(CONFIG.LOG_FILE, row, 'utf8');
}

function loadAlreadyUnfollowed() {
  if (!fs.existsSync(CONFIG.LOG_FILE)) return new Set();

  const content = fs.readFileSync(CONFIG.LOG_FILE, 'utf8');
  const usernames = content
    .split(/\r?\n/)
    .slice(1)
    .map(line => {
      const match = line.match(/^"[^"]+","([^"]+)"/);
      return match ? match[1].toLowerCase() : null;
    })
    .filter(Boolean);

  return new Set(usernames);
}

async function extractUsernameFromCell(cell) {
  const cellText = await cell.innerText().catch(() => '');
  const fromText = extractUsernameFromText(cellText);
  if (fromText) return fromText;

  const links = await cell.locator('a[href^="/"]').all();

  for (const link of links) {
    const href = await link.getAttribute('href').catch(() => null);
    if (!href) continue;

    const candidate = href.replace(/^\//, '').split('/')[0]?.toLowerCase();
    if (!candidate) continue;
    if (['home', 'explore', 'notifications', 'messages', 'settings', 'i', 'hashtag', 'search'].includes(candidate)) {
      continue;
    }

    return candidate;
  }

  return '';
}

async function getCellSearchText(cell) {
  const inner = normalizeSpaces(await cell.innerText().catch(() => ''));
  if (inner) return inner;

  return normalizeSpaces(await cell.textContent().catch(() => ''));
}

async function extractFullInfo(cell) {
  try {
    const username = await extractUsernameFromCell(cell);
    if (!username) return null;

    let displayName = '';
    try {
      const spans = await cell.locator('a span span').all();
      for (const span of spans) {
        const text = normalizeSpaces(await span.textContent().catch(() => ''));
        if (text && !text.startsWith('@')) {
          displayName = text;
          break;
        }
      }
    } catch {}

    let isMutual = false;
    try {
      const indicator = cell.locator(SELECTORS.MUTUAL_FOLLOW_BADGE);
      if ((await indicator.count()) > 0) {
        isMutual = true;
      }
    } catch {}

    if (!isMutual) {
      const cellText = await cell.innerText().catch(() => '');
      if (cellText.includes('フォローされています') || cellText.includes('Follows you')) {
        isMutual = true;
      }
    }

    const bioText = await getCellSearchText(cell);
    return {
      username,
      displayName: displayName || username,
      bioText,
      isMutual,
    };
  } catch {
    return null;
  }
}

function buildMatchText(info) {
  return normalizeSpaces([
    info.displayName,
    `@${info.username}`,
    info.bioText,
  ].join(' '));
}

function parseCandidateText(rawText) {
  const rawLines = String(rawText || '')
    .split(/\r?\n/)
    .map(normalizeSpaces)
    .filter(Boolean);

  const text = normalizeSpaces(rawLines.join('\n'));
  if (!text) return null;

  let username = '';
  for (const line of rawLines.slice(0, 6)) {
    const lineUsername = extractUsernameFromText(line);
    if (lineUsername) {
      username = lineUsername;
      break;
    }
  }

  if (!username) {
    username = extractUsernameFromText(text);
  }
  if (!username) return null;

  let displayName = username;
  const handleIndex = rawLines.findIndex(line => {
    const lineUsername = extractUsernameFromText(line);
    return lineUsername === username;
  });
  if (handleIndex > 0) {
    displayName = rawLines[handleIndex - 1];
  } else if (rawLines.length > 0 && !rawLines[0].startsWith('@')) {
    displayName = rawLines[0];
  }

  return {
    username,
    displayName: displayName || username,
    bioText: text,
    isMutual: text.includes('フォローされています') || text.includes('Follows you'),
  };
}

async function readCandidateTextFromButton(button) {
  return button.evaluate((element) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const hasHandle = (value) => /@[A-Za-z0-9_]{1,15}/.test(value || '');
    const hasFollowing = (value) => /フォロー中|Following/.test(value || '');
    const followSelector = '[data-testid$="-unfollow"]';

    let best = '';
    let node = element;
    for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
      const text = node.innerText || '';
      if (!hasHandle(text)) continue;
      if (!hasFollowing(text)) continue;

      const normalized = normalize(text);
      if (!normalized) continue;
      if (normalized.length > 1500) break;

       const buttonCount = Array.from(node.querySelectorAll(followSelector))
        .filter(candidate => /フォロー中|Following/.test(candidate.innerText || '')).length;
      if (buttonCount !== 1) continue;

      best = text;

      const visibleLines = text
        .split(/\r?\n/)
        .map(line => normalize(line))
        .filter(Boolean);

      if (visibleLines.length >= 3 || normalized.length >= 60) {
        return text;
      }
    }

    if (best) return best;

    node = element;
    for (let depth = 0; node && depth < 18; depth += 1, node = node.parentElement) {
      const text = node.innerText || '';
      if (hasHandle(text)) return text;
    }

    return '';
  }).catch(() => '');
}

async function readCandidateInfoFromButton(button) {
  const rawText = await readCandidateTextFromButton(button);
  const info = parseCandidateText(rawText);
  if (!info) return null;

  const dataTestId = await button.getAttribute('data-testid').catch(() => '');
  const directMatch = String(dataTestId || '').match(/^([A-Za-z0-9_]{1,15})-unfollow$/);
  if (directMatch) {
    info.username = directMatch[1].toLowerCase();
  }

  return info;
}

async function getVisibleCandidateSnapshot(page) {
  const buttons = page.locator(SELECTORS.FOLLOWING_BUTTON_CANDIDATES);
  const count = await buttons.count();
  const snapshot = [];
  const seenUsernames = new Set();

  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (!(await button.isVisible().catch(() => false))) continue;

    const info = await readCandidateInfoFromButton(button);
    if (!info || seenUsernames.has(info.username)) continue;

    const buttonHandle = await button.elementHandle().catch(() => null);
    if (!buttonHandle) continue;

    seenUsernames.add(info.username);
    snapshot.push({ index, buttonHandle, ...info });
  }

  return snapshot;
}

async function isNearBottom(page) {
  if (page.isClosed()) return true;
  return page.evaluate(() => {
    const doc = document.scrollingElement || document.documentElement;
    return doc.scrollTop + window.innerHeight >= doc.scrollHeight - 8;
  });
}

async function scrollForNextUsers(page, previousUsernames) {
  if (page.isClosed()) {
    return { advanced: false, snapshot: [], reachedBottom: true };
  }

  const previousSet = new Set(previousUsernames);
  let latestSnapshot = [];

  for (const amount of CONFIG.SCROLL_RETRY_AMOUNTS) {
    if (page.isClosed()) {
      return { advanced: false, snapshot: latestSnapshot, reachedBottom: true };
    }

    const beforeY = await page.evaluate(() => {
      const doc = document.scrollingElement || document.documentElement;
      return doc.scrollTop;
    });

    await page.evaluate((pixels) => {
      window.scrollBy(0, pixels);
    }, amount);

    if (!(await safeWaitForTimeout(page, CONFIG.WAIT_AFTER_SCROLL))) {
      return { advanced: false, snapshot: latestSnapshot, reachedBottom: true };
    }

    if (page.isClosed()) {
      return { advanced: false, snapshot: latestSnapshot, reachedBottom: true };
    }

    latestSnapshot = await getVisibleCandidateSnapshot(page);
    const currentUsernames = latestSnapshot.map(item => item.username);
    const hasNewVisibleUser = currentUsernames.some(username => !previousSet.has(username));
    if (hasNewVisibleUser) {
      return { advanced: true, snapshot: latestSnapshot, reachedBottom: false };
    }

    const afterY = await page.evaluate(() => {
      const doc = document.scrollingElement || document.documentElement;
      return doc.scrollTop;
    });

    const reachedBottom = await isNearBottom(page);
    if (reachedBottom && afterY === beforeY) {
      return { advanced: false, snapshot: latestSnapshot, reachedBottom: true };
    }
  }

  return {
    advanced: false,
    snapshot: latestSnapshot,
    reachedBottom: await isNearBottom(page),
  };
}

async function clickUnfollow(page, candidate) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (page.isClosed()) return false;

    const unfollowButton = candidate.buttonHandle;
    if (!unfollowButton) return false;

    const isConnected = await unfollowButton.evaluate(element => element.isConnected).catch(() => false);
    if (!isConnected) return false;

    const isVisible = await unfollowButton.isVisible().catch(() => false);
    if (!isVisible) {
      if (!(await safeWaitForTimeout(page, 300))) return false;
      continue;
    }

    const liveInfo = await readCandidateInfoFromButton(unfollowButton);
    if (!liveInfo || liveInfo.username !== candidate.username) {
      return false;
    }

    await unfollowButton.scrollIntoViewIfNeeded().catch(() => {});
    if (!(await safeWaitForTimeout(page, randomDelay(250, 150)))) return false;

    try {
      await unfollowButton.click({
        timeout: CONFIG.CLICK_TIMEOUT,
        force: false,
      });
    } catch (error) {
      if (attempt === 2) throw error;
      if (!(await safeWaitForTimeout(page, 500))) return false;
      continue;
    }

    if (!(await safeWaitForTimeout(page, randomDelay(900, 300)))) return false;

    for (const selector of SELECTORS.CONFIRM_BUTTONS) {
      const confirmButton = page.locator(selector);
      if (await confirmButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await confirmButton.click();
        if (!(await safeWaitForTimeout(page, randomDelay(500, 200)))) return false;
        return true;
      }
    }
  }

  console.log(`  [WARN] @${candidate.username} の解除ボタンを見つけられません`);
  return false;
}

async function ensureFollowingPage(page, followingUrl) {
  if (page.isClosed()) return false;
  const currentUrl = page.url();
  if (currentUrl.startsWith(followingUrl)) return true;

  console.log(`[WARN] 一覧外へ遷移したため戻します: ${currentUrl}`);
  await page.goto(followingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
  try {
    await page.waitForSelector(SELECTORS.FOLLOWING_BUTTON_CANDIDATES, { timeout: 15000 });
  } catch {
    return false;
  }
  return safeWaitForTimeout(page, 2000);
}

async function main() {
  console.log('');
  console.log('='.repeat(50));
  console.log('  X (Twitter) フォロー解除スクリプト');
  console.log('  取得安定化版');
  console.log('='.repeat(50));
  console.log('');

  const keepList = loadKeepList();
  const blockKeywords = loadBlockKeywords();
  initLog();

  const alreadyDone = loadAlreadyUnfollowed();
  const processedUsers = new Set();

  console.log(`[INFO] 既に解除済み: ${alreadyDone.size} 人（ログより）`);
  console.log(`[INFO] モード: ${CONFIG.KEYWORD_ONLY_MODE ? 'キーワード該当者のみ解除' : '全員解除'}`);
  console.log(`[INFO] 相互フォロー: ${CONFIG.UNFOLLOW_MUTUAL ? '解除する' : 'スキップ'}`);
  console.log(`[INFO] スクロール量: ${CONFIG.SCROLL_AMOUNT}px`);
  console.log(`[INFO] 停滞許容回数: ${CONFIG.MAX_STALLED_SCROLLS}`);
  console.log('');

  console.log('[INFO] Chrome を起動中...');
  const browser = await chromium.launchPersistentContext(CONFIG.PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = browser.pages()[0] || await browser.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  console.log('[INFO] X にアクセス中...');
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  let isLoggedIn = await page.locator(SELECTORS.LOGIN_CHECK).count();
  if (!isLoggedIn) {
    console.log('');
    console.log('  X にログインしてください。完了後 Enter を押してください。');
    console.log('');
    await new Promise(resolve => process.stdin.once('data', resolve));

    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    isLoggedIn = await page.locator(SELECTORS.LOGIN_CHECK).count();
    if (!isLoggedIn) {
      console.error('[ERROR] ログインが確認できません。');
      await browser.close();
      process.exit(1);
    }
  }

  const followingUrl = `https://x.com/${CONFIG.YOUR_USERNAME}/following`;
  console.log(`[INFO] フォロー中ページへ移動: ${followingUrl}`);
  await page.goto(followingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  try {
    await page.waitForSelector(SELECTORS.FOLLOWING_BUTTON_CANDIDATES, { timeout: 15000 });
  } catch {
    console.error('[ERROR] フォロー中ユーザーが読み込めませんでした。');
    await browser.close();
    return;
  }

  await page.waitForTimeout(3000);

  let unfollowCount = 0;
  let batchCount = 0;
  let skippedNoKeyword = 0;
  let skippedMutual = 0;
  let stalledScrolls = 0;
  const retryCounts = new Map();

  console.log('');
  console.log('[INFO] 解除開始...');
  console.log('');

  while (unfollowCount < CONFIG.UNFOLLOW_LIMIT) {
    if (page.isClosed()) {
      console.log('[INFO] ブラウザまたはページが閉じられたため終了します。');
      break;
    }

    if (!(await ensureFollowingPage(page, followingUrl))) {
      console.log('[INFO] フォロー中一覧へ戻れなかったため終了します。');
      break;
    }

    const snapshot = await getVisibleCandidateSnapshot(page);

    if (snapshot.length === 0) {
      stalledScrolls++;
      if (stalledScrolls >= CONFIG.MAX_STALLED_SCROLLS) {
        console.log('[INFO] 表示中のユーザーを取得できなくなったため終了します。');
        break;
      }

      await page.evaluate((pixels) => window.scrollBy(0, pixels), CONFIG.SCROLL_AMOUNT).catch(() => null);
      if (!(await safeWaitForTimeout(page, CONFIG.WAIT_AFTER_SCROLL))) break;
      continue;
    }

    const visibleUsernames = snapshot.map(item => item.username);
    const visibleMatches = snapshot.filter(item => matchesBlockKeyword(item.bioText, blockKeywords));
    const pendingVisibleMatches = visibleMatches.filter(item => !processedUsers.has(item.username));
    console.log(`[SCAN] 可視:${snapshot.length} 件  該当:${visibleMatches.length} 件  未処理該当:${pendingVisibleMatches.length} 件`);
    let processedNewUser = false;
    let actedThisPass = false;

    for (const info of snapshot) {
      const { username } = info;
      if (unfollowCount >= CONFIG.UNFOLLOW_LIMIT) break;
      if (processedUsers.has(username)) continue;

      processedNewUser = true;

      if (keepList.has(username)) {
        processedUsers.add(username);
        if (CONFIG.DEBUG_LOG) {
          console.log(`  [SKIP] @${username} ホワイトリスト`);
        }
        continue;
      }

      const matchText = info.bioText || buildMatchText(info);
      const matchedKeyword = matchesBlockKeyword(matchText, blockKeywords);

      if (CONFIG.KEYWORD_ONLY_MODE && !matchedKeyword) {
        skippedNoKeyword++;
        processedUsers.add(username);
        continue;
      }

      if (info.isMutual && !CONFIG.UNFOLLOW_MUTUAL) {
        skippedMutual++;
        processedUsers.add(username);
        continue;
      }

      try {
        const clicked = await clickUnfollow(page, info);
        if (!clicked) {
          const retries = (retryCounts.get(username) || 0) + 1;
          retryCounts.set(username, retries);
          if (retries >= CONFIG.MAX_RETRY_PER_USER) {
            processedUsers.add(username);
            console.log(`  [WARN] @${username} は ${retries} 回連続で失敗したため、今回は保留します`);
          }
          break;
        }

        unfollowCount++;
        batchCount++;
        alreadyDone.add(username);
        processedUsers.add(username);
        retryCounts.delete(username);
        actedThisPass = true;

        const reason = matchedKeyword ? `キーワード: ${matchedKeyword}` : '通常解除';
        appendLog(
          username,
          info.displayName,
          `https://x.com/${username}`,
          reason,
          info.isMutual,
        );

        const mutualMark = info.isMutual ? ' [相互]' : '';
        const keywordMark = matchedKeyword ? ` [${matchedKeyword}]` : '';
        console.log(`  [UNFOLLOW #${unfollowCount}] @${username} (${info.displayName})${mutualMark}${keywordMark}`);

        if (batchCount >= CONFIG.BATCH_SIZE) {
          console.log(`\n  [PAUSE] ${CONFIG.BATCH_SIZE} 件完了。${CONFIG.DELAY_AFTER_BATCH / 1000} 秒休憩...\n`);
          if (!(await safeWaitForTimeout(page, CONFIG.DELAY_AFTER_BATCH))) break;
          batchCount = 0;
        } else {
          if (!(await safeWaitForTimeout(page, randomDelay(CONFIG.DELAY_BETWEEN_UNFOLLOW, 800)))) break;
        }
        break;
      } catch (error) {
        const retries = (retryCounts.get(username) || 0) + 1;
        retryCounts.set(username, retries);
        console.error(`  [ERROR] @${username} の解除に失敗: ${error.message}`);
        if (retries >= CONFIG.MAX_RETRY_PER_USER) {
          processedUsers.add(username);
          console.log(`  [WARN] @${username} は ${retries} 回連続で失敗したため、今回は保留します`);
        }
        break;
      }
    }

    if (page.isClosed()) {
      console.log('[INFO] ブラウザまたはページが閉じられたため終了します。');
      break;
    }

    if (!(await ensureFollowingPage(page, followingUrl))) {
      console.log('[INFO] フォロー中一覧へ戻れなかったため終了します。');
      break;
    }

    if (actedThisPass) {
      stalledScrolls = 0;
      continue;
    }

    const scrollResult = await scrollForNextUsers(page, visibleUsernames);
    if (scrollResult.advanced || processedNewUser) {
      stalledScrolls = 0;
      continue;
    }

    stalledScrolls++;
    if (scrollResult.reachedBottom) {
      console.log('[INFO] 一覧の末尾まで到達したため終了します。');
      break;
    }

    if (stalledScrolls >= CONFIG.MAX_STALLED_SCROLLS) {
      console.log('[INFO] 新しいユーザーを一定回数取得できなかったため終了します。');
      break;
    }
  }

  console.log('');
  console.log('='.repeat(50));
  console.log(`  [DONE] 今回の解除数:            ${unfollowCount} 人`);
  console.log(`  [DONE] チェック済みユーザー:     ${processedUsers.size} 人`);
  console.log(`  [DONE] キーワード非該当スキップ: ${skippedNoKeyword} 人`);
  console.log(`  [DONE] 相互フォロースキップ:     ${skippedMutual} 人`);
  console.log(`  [DONE] 累計解除数:               ${alreadyDone.size} 人`);
  console.log(`  [DONE] ログ出力先:               ${path.resolve(CONFIG.LOG_FILE)}`);
  console.log('='.repeat(50));
  console.log('');

  await browser.close();
}

main().catch(async (error) => {
  console.error('[FATAL]', error);
  process.exit(1);
});
