const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const ESPN_SCOREBOARD_URL =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";

const TOURNAMENT_DATES = "20260611-20260719";

const GOOGLE_ASSIGNMENTS_CSV_URL = process.env.GOOGLE_ASSIGNMENTS_CSV_URL;
const GOOGLE_ALL_TEAMS_CSV_URL = process.env.GOOGLE_ALL_TEAMS_CSV_URL;

// ESPN cache
const CACHE_TTL_MS = 2 * 60 * 1000;
const STALE_CACHE_TTL_MS = 60 * 60 * 1000;

// Google Sheet cache
const ASSIGNMENTS_CACHE_TTL_MS = 2 * 60 * 1000;
const ALL_TEAMS_CACHE_TTL_MS = 2 * 60 * 1000;

let cache = {
  data: null,
  fetchedAt: null,
  expiresAt: null
};

let assignmentsCache = {
  data: null,
  fetchedAt: null,
  expiresAt: null
};

let allTeamsCache = {
  data: null,
  fetchedAt: null,
  expiresAt: null
};

let refreshInProgress = null;

const scoringRules = {
  group: 1,
  r32: 3,
  r16: 3,
  qf: 3,
  sf: 4,
  third: 4,
  final: 5,
  missedKnockoutPenalty: -2
};

const STARTING_GROUP_POINTS_REMAINING = 48;
const GROUP_POINTS_USED_PER_MATCH = 3;

const nationAliases = {
  USA: "United States",
  "United States": "United States",
  "United States of America": "United States",

  "Bosnia & Herzegovina": "Bosnia and Herzegovina",
"Bosnia and Herzegovina": "Bosnia and Herzegovina",
"Bosnia-Herzegovina": "Bosnia and Herzegovina",
"BIH": "Bosnia and Herzegovina",

  "Korea Republic": "South Korea",
  Korea: "South Korea",
  "South Korea": "South Korea",

  "IR Iran": "Iran",
  Iran: "Iran",

  England: "England",
  Curaçao: "Curaçao", "Curacao"
  Argentina: "Argentina",
  Brazil: "Brazil",
  Cape Verde: "Cape Verde", "Cabo Verde",
  France: "France",
  Spain: "Spain",
  Germany: "Germany",
  Portugal: "Portugal",
  Mexico: "Mexico",
  Canada: "Canada",
  Japan: "Japan",
  Ghana: "Ghana",
  Morocco: "Morocco",
  Uruguay: "Uruguay"
};

function normalizeNation(name) {
  if (!name) return "Unknown";
  return nationAliases[name.trim()] || name.trim();
}

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"' && insideQuotes && nextChar === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
      insideQuotes = !insideQuotes;
    } else if (char === "," && !insideQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

function parseAssignmentsCsv(csvText) {
  const lines = csvText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const rows = lines.map(parseCsvLine);

  return rows
    .slice(1)
    .map(row => ({
      player: row[0],
      nations: [row[1], row[2], row[3], row[4]]
        .filter(Boolean)
        .map(normalizeNation)
    }))
    .filter(entry => entry.player && entry.nations.length > 0);
}

function parseAllTeamsCsv(csvText) {
  const lines = csvText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const rows = lines.map(parseCsvLine);

  return rows
    .slice(1)
    .map(row => normalizeNation(row[0]))
    .filter(Boolean)
    .sort();
}

async function fetchAssignmentsFromGoogle() {
  if (!GOOGLE_ASSIGNMENTS_CSV_URL) {
    throw new Error("GOOGLE_ASSIGNMENTS_CSV_URL is missing in Render.");
  }

  const response = await fetch(GOOGLE_ASSIGNMENTS_CSV_URL);

  if (!response.ok) {
    throw new Error(`Google Assignments request failed with status ${response.status}`);
  }

  const csvText = await response.text();
  return parseAssignmentsCsv(csvText);
}

async function fetchAllTeamsFromGoogle() {
  if (!GOOGLE_ALL_TEAMS_CSV_URL) {
    throw new Error("GOOGLE_ALL_TEAMS_CSV_URL is missing in Render.");
  }

  const response = await fetch(GOOGLE_ALL_TEAMS_CSV_URL);

  if (!response.ok) {
    throw new Error(`Google All Teams request failed with status ${response.status}`);
  }

  const csvText = await response.text();
  return parseAllTeamsCsv(csvText);
}

async function getDraftBoard() {
  const now = Date.now();

  if (
    assignmentsCache.data &&
    assignmentsCache.expiresAt &&
    now < assignmentsCache.expiresAt
  ) {
    return assignmentsCache.data;
  }

  const assignments = await fetchAssignmentsFromGoogle();

  assignmentsCache = {
    data: assignments,
    fetchedAt: now,
    expiresAt: now + ASSIGNMENTS_CACHE_TTL_MS
  };

  return assignments;
}

async function getAllTeams() {
  const now = Date.now();

  if (
    allTeamsCache.data &&
    allTeamsCache.expiresAt &&
    now < allTeamsCache.expiresAt
  ) {
    return allTeamsCache.data;
  }

  const allTeams = await fetchAllTeamsFromGoogle();

  allTeamsCache = {
    data: allTeams,
    fetchedAt: now,
    expiresAt: now + ALL_TEAMS_CACHE_TTL_MS
  };

  return allTeams;
}

function getAssignedTeams(draftBoard) {
  const assigned = new Set();

  draftBoard.forEach(entry => {
    entry.nations.forEach(nation => {
      assigned.add(normalizeNation(nation));
    });
  });

  return assigned;
}

function getAvailableTeams(allTeams, draftBoard) {
  const assignedTeams = getAssignedTeams(draftBoard);

  return allTeams
    .map(normalizeNation)
    .filter(team => !assignedTeams.has(team))
    .sort();
}

function createEmptyNationScore() {
  return {
    total: 0,
    group: 0,
    r32: 0,
    r16: 0,
    qf: 0,
    sf: 0,
    third: 0,
    final: 0,
    missedKnockout: 0,
    groupMatchesPlayed: 0,
    knockoutAppearances: 0,
    matches: []
  };
}
function ensureNation(scores, nation) {
  const normalized = normalizeNation(nation);

  if (!scores[normalized]) {
    scores[normalized] = createEmptyNationScore();
  }

  return normalized;
}

function addNationPoints(scores, nation, points, stage, matchLabel) {
  const normalized = ensureNation(scores, nation);

  scores[normalized].total += points;
  scores[normalized][stage] += points;

  scores[normalized].matches.push({
    match: matchLabel,
    stage,
    points
  });
}

function recordGroupMatchPlayed(scores, nation) {
  const normalized = ensureNation(scores, nation);
  scores[normalized].groupMatchesPlayed += 1;
}

function recordKnockoutAppearance(scores, nation) {
  const normalized = ensureNation(scores, nation);
  scores[normalized].knockoutAppearances += 1;
}

function detectStage(event) {
  const text = [
    event.name,
    event.shortName,
    event.season?.slug,
    event.season?.type?.name,
    event.competitions?.[0]?.stage?.description,
    event.competitions?.[0]?.type?.text,
    JSON.stringify(event.competitions?.[0]?.notes || [])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (text.includes("third place") || text.includes("3rd place")) {
    return "third";
  }

  if (text.includes("final") && !text.includes("semi") && !text.includes("quarter")) {
    return "final";
  }

  if (text.includes("semi")) {
    return "sf";
  }

  if (text.includes("quarter")) {
    return "qf";
  }

  if (text.includes("round of 16") || text.includes("last 16")) {
    return "r16";
  }

  if (text.includes("round of 32") || text.includes("last 32")) {
    return "r32";
  }

  if (text.includes("group")) {
    return "group";
  }

  return "group";
}

function getCompetitors(event) {
  return event.competitions?.[0]?.competitors || [];
}

function isCompleted(event) {
  return event.status?.type?.completed === true;
}

function getTeamName(competitor) {
  return normalizeNation(
    competitor.team?.displayName ||
    competitor.team?.name ||
    competitor.team?.shortDisplayName
  );
}

function parseMatch(event) {
  const competitors = getCompetitors(event);

  if (competitors.length !== 2) {
    return null;
  }

  const teamA = competitors[0];
  const teamB = competitors[1];

  const teamAName = getTeamName(teamA);
  const teamBName = getTeamName(teamB);

  const teamAScore = Number(teamA.score);
  const teamBScore = Number(teamB.score);

  const winner =
    teamA.winner === true ? teamAName :
    teamB.winner === true ? teamBName :
    null;

  return {
    teamAName,
    teamBName,
    teamAScore,
    teamBScore,
    winner
  };
}

function scoreCompletedEvent(event, nationScores) {
  if (!isCompleted(event)) {
    return;
  }

  const stage = detectStage(event);
  const match = parseMatch(event);

  if (!match) {
    return;
  }

  const matchLabel = event.name || event.shortName || "Unknown match";

  if (stage === "group") {
    recordGroupMatchPlayed(nationScores, match.teamAName);
    recordGroupMatchPlayed(nationScores, match.teamBName);

    if (match.teamAScore > match.teamBScore) {
      addNationPoints(nationScores, match.teamAName, 3, "group", matchLabel);
      addNationPoints(nationScores, match.teamBName, 0, "group", matchLabel);
    } else if (match.teamBScore > match.teamAScore) {
      addNationPoints(nationScores, match.teamBName, 3, "group", matchLabel);
      addNationPoints(nationScores, match.teamAName, 0, "group", matchLabel);
    } else {
      addNationPoints(nationScores, match.teamAName, 1, "group", matchLabel);
      addNationPoints(nationScores, match.teamBName, 1, "group", matchLabel);
    }

    return;
  }

  recordKnockoutAppearance(nationScores, match.teamAName);
  recordKnockoutAppearance(nationScores, match.teamBName);

  if (!match.winner) {
    return;
  }

  addNationPoints(
    nationScores,
    match.winner,
    scoringRules[stage],
    stage,
    matchLabel
  );
}

function applyMissedKnockoutPenalties(nationScores) {
  const knockoutHasStartedOrBracketExists = Object.values(nationScores).some(score => {
    return score.knockoutAppearances > 0;
  });

  if (!knockoutHasStartedOrBracketExists) {
    return;
  }

  Object.entries(nationScores).forEach(([nation, score]) => {
    const completedGroupStage = score.groupMatchesPlayed >= 3;
    const madeKnockoutStage = score.knockoutAppearances > 0;
    const alreadyPenalized = score.missedKnockout < 0;

    if (completedGroupStage && !madeKnockoutStage && !alreadyPenalized) {
      addNationPoints(
        nationScores,
        nation,
        scoringRules.missedKnockoutPenalty,
        "missedKnockout",
        "Did not make knockout stage"
      );
    }
  });
}

function buildLeaderboard(nationScores, draftBoard) {
  return draftBoard
    .map(entry => {
      const nations = entry.nations.map(normalizeNation);

      const nationBreakdown = nations.map(nation => ({
        nation,
        score: nationScores[nation]?.total || 0,
        group: nationScores[nation]?.group || 0,
        r32: nationScores[nation]?.r32 || 0,
        r16: nationScores[nation]?.r16 || 0,
        qf: nationScores[nation]?.qf || 0,
        sf: nationScores[nation]?.sf || 0,
        third: nationScores[nation]?.third || 0,
        final: nationScores[nation]?.final || 0,
        missedKnockout: nationScores[nation]?.missedKnockout || 0,
        groupMatchesPlayed: nationScores[nation]?.groupMatchesPlayed || 0
      }));

      const total = nationBreakdown.reduce((sum, item) => {
        return sum + item.score;
      }, 0);

      const groupGamesPlayed = nationBreakdown.reduce((sum, item) => {
        return sum + item.groupMatchesPlayed;
      }, 0);

      const groupPointsRemaining =
        STARTING_GROUP_POINTS_REMAINING -
        groupGamesPlayed * GROUP_POINTS_USED_PER_MATCH;

      return {
        player: entry.player,
        nations,
        nationBreakdown,
        total,
        groupGamesPlayed,
        groupPointsRemaining
      };
    })
    .sort((a, b) => b.total - a.total);
}

async function fetchFromEspn() {
  const url = `${ESPN_SCOREBOARD_URL}?limit=1000&dates=${TOURNAMENT_DATES}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "WorldCupDraftScoreboard/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`ESPN request failed with status ${response.status}`);
  }

  return response.json();
}

function calculateScores(espnData, draftBoard) {
  const events = espnData.events || [];
  const nationScores = {};

  draftBoard.forEach(entry => {
    entry.nations.forEach(nation => ensureNation(nationScores, nation));
  });

events.forEach(event => {
  scoreCompletedEvent(event, nationScores);
});

applyMissedKnockoutPenalties(nationScores);

return {
    updatedAt: new Date().toISOString(),
    source: "ESPN + Google Sheets",
    tournamentDates: TOURNAMENT_DATES,
    eventCount: events.length,
    leaderboard: buildLeaderboard(nationScores, draftBoard),
    nationScores
  };
}

async function refreshScores() {
  const draftBoard = await getDraftBoard();
  const espnData = await fetchFromEspn();
  const calculated = calculateScores(espnData, draftBoard);

  cache = {
    data: calculated,
    fetchedAt: Date.now(),
    expiresAt: Date.now() + CACHE_TTL_MS
  };

  return calculated;
}

async function getScoresWithCache() {
  const now = Date.now();

  if (cache.data && cache.expiresAt && now < cache.expiresAt) {
    return {
      ...cache.data,
      cacheStatus: "fresh-cache",
      cacheAgeSeconds: Math.round((now - cache.fetchedAt) / 1000)
    };
  }

  if (!refreshInProgress) {
    refreshInProgress = refreshScores().finally(() => {
      refreshInProgress = null;
    });
  }

  try {
    const freshData = await refreshInProgress;

    return {
      ...freshData,
      cacheStatus: "refreshed",
      cacheAgeSeconds: 0
    };
  } catch (error) {
    const staleCacheStillOkay =
      cache.data &&
      cache.fetchedAt &&
      now - cache.fetchedAt < STALE_CACHE_TTL_MS;

    if (staleCacheStillOkay) {
      return {
        ...cache.data,
        cacheStatus: "stale-cache",
        cacheAgeSeconds: Math.round((now - cache.fetchedAt) / 1000),
        warning: "ESPN refresh failed, so this is using recently cached data."
      };
    }

    throw error;
  }
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/scores", async (req, res) => {
  try {
    const data = await getScoresWithCache();
    res.set("Cache-Control", "public, max-age=30");
    res.json(data);
  } catch (error) {
    res.status(500).json({
      error: "Could not load World Cup scores.",
      details: error.message
    });
  }
});

app.get("/api/team-assignments", async (req, res) => {
  try {
    const draftBoard = await getDraftBoard();
    const allTeams = await getAllTeams();
    const availableTeams = getAvailableTeams(allTeams, draftBoard);

    res.set("Cache-Control", "public, max-age=30");

    res.json({
      updatedAt: new Date().toISOString(),
      source: "Google Sheets",
      assignments: draftBoard,
      allTeams,
      availableTeams
    });
  } catch (error) {
    res.status(500).json({
      error: "Could not load team assignments.",
      details: error.message
    });
  }
});

app.get("/api/debug/events", async (req, res) => {
  try {
    const espnData = await fetchFromEspn();

    const simplifiedEvents = (espnData.events || []).map(event => ({
      id: event.id,
      name: event.name,
      shortName: event.shortName,
      date: event.date,
      completed: event.status?.type?.completed,
      detectedStage: detectStage(event),
      competitors: getCompetitors(event).map(c => ({
        name: c.team?.displayName,
        score: c.score,
        winner: c.winner
      }))
    }));

    res.json(simplifiedEvents);
  } catch (error) {
    res.status(500).json({
      error: "Could not load ESPN debug events.",
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Scoreboard running on port ${PORT}`);
});
