import { db, getDoc, doc } from './firebase-service.js'; // Only need db access for the session doc
import { allMatches } from './match-data-service.js';
import { teamA1Select, teamA2Select, teamB1Select, teamB2Select } from './dom-elements.js';
import { notifyRolesChanged } from "./match-form-handler.js";
import { getCachedStats, isCacheReady } from './stats-cache-service.js';
import { STARTING_ELO, SESSION_GAP_MS } from './constants.js';

const SUGGESTION_TTL = SESSION_GAP_MS;

const WAITING_KARMA_DEFAULTS = {
  recencyBoosts: [1.5, 1.25],
  durationInfluence: 0,
};

const PAIRING_SAMPLING_DEFAULTS = {
  scoreSpreadTemperatureDivisor: 8,
  scoreTemperatureFloor: 1,
  interTeamEloScale: 140,
  interTeamEloStrength: 1,
  minCandidateWeight: 1e-12,
};

let lastSuggestion = null;

function getSeasonElo(playerName) {
  if (!isCacheReady()) {
    return STARTING_ELO;
  }
  const stats = getCachedStats(playerName);
  if (!stats || !Array.isArray(stats.eloTrajectory) || stats.eloTrajectory.length === 0) {
    return STARTING_ELO;
  }
  return stats.eloTrajectory[stats.eloTrajectory.length - 1].elo ?? STARTING_ELO;
}

function cloneTeam(team = []) {
  return Array.isArray(team) ? [...team] : [];
}

function areTeamsEqual(teamA = [], teamB = []) {
  if (teamA.length !== teamB.length) return false;
  const sortedA = [...teamA].sort();
  const sortedB = [...teamB].sort();
  return sortedA.every((player, idx) => player === sortedB[idx]);
}

function pairingMatchesSuggestion(suggestedRed = [], suggestedBlue = [], currentRed = [], currentBlue = []) {
  const directMatch = areTeamsEqual(suggestedRed, currentRed) && areTeamsEqual(suggestedBlue, currentBlue);
  const swappedMatch = areTeamsEqual(suggestedRed, currentBlue) && areTeamsEqual(suggestedBlue, currentRed);
  return directMatch || swappedMatch;
}

function storeLastSuggestion(redTeam, blueTeam, activePlayers) {
  lastSuggestion = {
    redTeam: cloneTeam(redTeam),
    blueTeam: cloneTeam(blueTeam),
    activePlayers: Array.isArray(activePlayers) ? [...activePlayers] : [],
    suggestedAt: Date.now()
  };
}

export function evaluateLastSuggestion(currentRedTeam = [], currentBlueTeam = []) {
  if (!lastSuggestion) {
    return { hasSuggestion: false };
  }
  const { redTeam, blueTeam, suggestedAt, activePlayers } = lastSuggestion;
  const pairingMatched = pairingMatchesSuggestion(redTeam, blueTeam, currentRedTeam, currentBlueTeam);
  const isFresh = (Date.now() - suggestedAt) <= SUGGESTION_TTL;
  return {
    hasSuggestion: true,
    pairingMatched,
    isFresh,
    suggestedAt,
    activePlayers: [...activePlayers]
  };
}

export function clearLastSuggestion() {
  lastSuggestion = null;
}

function collectRelevantPlayers(sessionMatches, activePlayers) {
  const playerSet = new Set(Array.isArray(activePlayers) ? activePlayers : []);
  sessionMatches.forEach(match => {
    [...match.teamA, ...match.teamB].forEach(player => playerSet.add(player));
    const waiting = match?.pairingMetadata?.waitingPlayers || [];
    waiting.forEach(player => playerSet.add(player));
  });
  return Array.from(playerSet);
}

function buildAttendanceMatrix(sessionMatches, relevantPlayers) {
  const attendance = new Map();
  relevantPlayers.forEach(player => {
    attendance.set(player, new Array(sessionMatches.length).fill(0));
  });

  sessionMatches.forEach((match, matchIdx) => {
    const activeSet = new Set([...match.teamA, ...match.teamB]);
    const waiting = match?.pairingMetadata?.waitingPlayers || [];
    waiting.forEach(player => activeSet.add(player));
    relevantPlayers.forEach(player => {
      if (activeSet.has(player)) {
        const weights = attendance.get(player);
        weights[matchIdx] = 1;
      }
    });
  });

  relevantPlayers.forEach(player => {
    const weights = attendance.get(player);
    for (let i = 0; i < weights.length - 1; i++) {
      if (weights[i] === 0 && weights[i + 1] === 1) {
        weights[i] = 0.5;
      }
    }
  });

  return attendance;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function buildRecencyMultipliers(length, recencyBoosts = []) {
  const multipliers = new Array(length).fill(1);
  if (!Array.isArray(recencyBoosts) || !recencyBoosts.length) {
    return multipliers;
  }

  let matchIdx = length - 1;
  for (let i = 0; i < recencyBoosts.length && matchIdx >= 0; i += 1, matchIdx -= 1) {
    const boost = recencyBoosts[i];
    if (typeof boost === 'number' && Number.isFinite(boost) && boost > 0) {
      multipliers[matchIdx] = boost;
    } else {
      console.warn(`Invalid recency boost at index ${i}:`, boost);
    }
  }
  return multipliers;
}

function buildDurationMultipliers(sessionMatches, influenceRaw = 0) {
  const influence = clamp(typeof influenceRaw === 'number' ? influenceRaw : 0, 0, 1);
  const length = sessionMatches.length;
  const multipliers = new Array(length).fill(1);
  if (length === 0 || influence === 0) {
    return multipliers;
  }

  const durations = sessionMatches.map(match => (typeof match.matchDuration === 'number' && match.matchDuration > 0) ? match.matchDuration : null);
  const validDurations = durations.filter(d => d !== null);
  if (!validDurations.length) {
    return multipliers;
  }

  const avgDuration = validDurations.reduce((sum, d) => sum + d, 0) / validDurations.length || 1;
  if (avgDuration === 0) {
    return multipliers;
  }

  durations.forEach((duration, idx) => {
    const ratio = duration === null ? 1 : duration / avgDuration;
    const safeRatio = ratio > 0 ? ratio : 1;
    const interpolated = (1 - influence) * 1 + influence * safeRatio;
    multipliers[idx] = interpolated;
  });

  return multipliers;
}

function computeWaitingKarma(sessionMatches, activePlayers, options = WAITING_KARMA_DEFAULTS) {
  if (!sessionMatches.length) {
    const karma = {};
    (activePlayers || []).forEach(player => {
      karma[player] = 0;
    });
    return karma;
  }

  const mergedOptions = {
    ...WAITING_KARMA_DEFAULTS,
    ...(options || {}),
  };

  const recencyMultipliers = buildRecencyMultipliers(sessionMatches.length, mergedOptions.recencyBoosts);
  const durationMultipliers = buildDurationMultipliers(sessionMatches, mergedOptions.durationInfluence);
  const matchMultipliers = recencyMultipliers.map((value, idx) => value * durationMultipliers[idx]);

  const relevantPlayers = collectRelevantPlayers(sessionMatches, activePlayers);
  if (!relevantPlayers.length) {
    return {};
  }

  const attendanceMatrix = buildAttendanceMatrix(sessionMatches, relevantPlayers);
  const participantSets = sessionMatches.map(match => new Set([...match.teamA, ...match.teamB]));

  const karma = {};
  relevantPlayers.forEach(player => { karma[player] = 0; });

  sessionMatches.forEach((match, idx) => {
    const matchWeight = matchMultipliers[idx] || 1;
    const participants = participantSets[idx];
    const Pt = match.teamA.length + match.teamB.length;
    if (Pt === 0) {
      return;
    }
    let Wt = 0;
    relevantPlayers.forEach(player => {
      Wt += attendanceMatrix.get(player)[idx];
    });
    if (Wt === 0) {
      relevantPlayers.forEach(player => {
        const plays = participants.has(player) ? 1 : 0;
        karma[player] -= matchWeight * plays;
      });
      return;
    }

    relevantPlayers.forEach(player => {
      const plays = participants.has(player) ? 1 : 0;
      const weight = attendanceMatrix.get(player)[idx];
      const delta = -plays + (weight * Pt) / Wt;
      karma[player] += matchWeight * delta;
    });
  });

  (activePlayers || []).forEach(player => {
    if (!(player in karma)) {
      karma[player] = 0;
    }
  });

  return karma;
}

function splitSession(matches) {
    if (!matches.length) return { session: [], historic: [] };
    const now = Date.now();
    const session = [];
    const historic = [];

    let sessionStartIdx = matches.length;
    for (let i = matches.length - 1; i >= 0; i--) {
        // Use the timestamp from the match data
        if (now - matches[i].timestamp > SESSION_GAP_MS) {
            sessionStartIdx = i + 1;
            break;
        }
    }

    for (let i = 0; i < matches.length; i++) {
        if (i >= sessionStartIdx) {
            session.push(matches[i]);
        } else {
            historic.push(matches[i]);
        }
    }
    return { session, historic };
}

function countPlaysPerPlayer(sessionMatches, activePlayers) {
  const count = {};
  activePlayers.forEach(n => count[n] = 0);
  sessionMatches.forEach(m => {
    [...m.teamA, ...m.teamB]
      .filter(p => activePlayers.includes(p))
      .forEach(p => count[p]++);
  });
  return count;
}

function buildCoAndOppCounts(matches, activePlayers) {
  const withCount = {}, againstCount = {};
  activePlayers.forEach(a => {
    withCount[a] = {};
    againstCount[a] = {};
    activePlayers.forEach(b => {
      if (a !== b) {
        withCount[a][b] = 0;
        againstCount[a][b] = 0;
      }
    });
  });

  matches.forEach(m => {
    const A = m.teamA, B = m.teamB;
    [A, B].forEach(team => {
      team.forEach(p1 => team.forEach(p2 => {
        if (p1 !== p2 && withCount[p1] && withCount[p2]) {
          withCount[p1][p2]++;
        }
      }));
    });
    A.forEach(pA => B.forEach(pB => {
      if (againstCount[pA] && againstCount[pB]) {
        againstCount[pA][pB]++;
        againstCount[pB][pA]++;
      }
    }));
  });

  return { withCount, againstCount };
}

function generatePairings(activePlayers) {
  const pairings = [];
  const n = activePlayers.length;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (let c = b + 1; c < n; c++) {
        for (let d = c + 1; d < n; d++) {
          const quad = [activePlayers[a], activePlayers[b], activePlayers[c], activePlayers[d]];
          const teams = [
            [[quad[0], quad[1]], [quad[2], quad[3]]],
            [[quad[0], quad[2]], [quad[1], quad[3]]],
            [[quad[0], quad[3]], [quad[1], quad[2]]],
          ];
          teams.forEach(t => pairings.push({ teamA: t[0], teamB: t[1] }));
        }
      }
    }
  }
  return pairings;
}

function getPairingEloDiffs(teamA, teamB, eloMap) {
  const eloA0 = eloMap[teamA[0]];
  const eloA1 = eloMap[teamA[1]];
  const eloB0 = eloMap[teamB[0]];
  const eloB1 = eloMap[teamB[1]];

  const intraDiff = Math.abs(eloA0 - eloA1) + Math.abs(eloB0 - eloB1);
  const interDiff = Math.abs((eloA0 + eloA1) / 2 - (eloB0 + eloB1) / 2);

  return { intraDiff, interDiff };
}

function scorePairing(p, data) {
  const {
    playsCount,
    countsSession,
    countsHistoric,
    eloMap,
    waitingKarmaMap = {}
  } = data;

  const w = {
    sessionPlays: 0,
    sessionTeammateRepeat: 100.0,
    historicTeammateRepeat: 0.0,
    sessionOpponentRepeat: 40.0,
    historicOpponentRepeat: 0.0,
    intraTeamEloDiff: 0.0,
    interTeamEloDiff: 0.0,
    waitingKarma: 100000.0,
  };

  const { teamA, teamB } = p;
  const playsSess = (playsCount[teamA[0]] || 0) + (playsCount[teamA[1]] || 0) +
                    (playsCount[teamB[0]] || 0) + (playsCount[teamB[1]] || 0);

  const repSess = (teamA.length === 2 ? countsSession.withCount[teamA[0]][teamA[1]] : 0)
                + (teamB.length === 2 ? countsSession.withCount[teamB[0]][teamB[1]] : 0);
  const repHist = (teamA.length === 2 ? countsHistoric.withCount[teamA[0]][teamA[1]] : 0)
                + (teamB.length === 2 ? countsHistoric.withCount[teamB[0]][teamB[1]] : 0);

  let oppRepSess = 0;
  teamA.forEach(a => teamB.forEach(b => { oppRepSess += countsSession.againstCount[a][b]; }));
  let oppRepHist = 0;
  teamA.forEach(a => teamB.forEach(b => { oppRepHist += countsHistoric.againstCount[a][b]; }));

  const { intraDiff, interDiff } = getPairingEloDiffs(teamA, teamB, eloMap);

  const karmaSum = [...teamA, ...teamB].reduce((sum, player) => sum + (waitingKarmaMap[player] || 0), 0);

  const score = -w.sessionPlays * playsSess - w.sessionTeammateRepeat * repSess - w.historicTeammateRepeat * repHist
    - w.sessionOpponentRepeat * oppRepSess - w.historicOpponentRepeat * oppRepHist
    - w.intraTeamEloDiff * intraDiff - w.interTeamEloDiff * interDiff
    + w.waitingKarma * karmaSum;

  // log some things for debugging
  // console.log(`Pairing: [${teamA[0]}, ${teamA[1]}] vs) [${teamB[0]}, ${teamB[1]}]`);
  // console.log(`  Plays in session: ${playsSess}`);
  // console.log(`  Waiting karma sum: ${Object.values(waitingKarmaMap).reduce((a, b) => a + b, 0)}`);
  // console.log(`  Teammate repeats - session: ${repSess}, historic: ${repHist}`);
  // console.log(`  Opponent repeats - session: ${oppRepSess}, historic: ${
  // oppRepHist}`);
  // console.log(`  Intra-team Elo diff: ${intraDiff}`);
  // console.log(`  Inter-team Elo diff: ${interDiff}`);

  return score;
}

function buildSamplingWeights(scoredCandidates, options = PAIRING_SAMPLING_DEFAULTS) {
  if (!scoredCandidates.length) {
    return [];
  }

  const mergedOptions = {
    ...PAIRING_SAMPLING_DEFAULTS,
    ...(options || {}),
  };

  let maxScore = -Infinity;
  let minScore = Infinity;
  for (const candidate of scoredCandidates) {
    const candidateScore = Number.isFinite(candidate?.score) ? candidate.score : 0;
    if (candidateScore > maxScore) {
      maxScore = candidateScore;
    }
    if (candidateScore < minScore) {
      minScore = candidateScore;
    }
  }
  if (!Number.isFinite(maxScore)) {
    maxScore = 0;
  }
  if (!Number.isFinite(minScore)) {
    minScore = 0;
  }

  const scoreSpread = maxScore - minScore;
  const safeScoreSpreadDivisor =
    (typeof mergedOptions.scoreSpreadTemperatureDivisor === 'number'
      && Number.isFinite(mergedOptions.scoreSpreadTemperatureDivisor)
      && mergedOptions.scoreSpreadTemperatureDivisor > 0)
      ? mergedOptions.scoreSpreadTemperatureDivisor
      : PAIRING_SAMPLING_DEFAULTS.scoreSpreadTemperatureDivisor;
  const safeScoreTemperatureFloor =
    (typeof mergedOptions.scoreTemperatureFloor === 'number'
      && Number.isFinite(mergedOptions.scoreTemperatureFloor)
      && mergedOptions.scoreTemperatureFloor > 0)
      ? mergedOptions.scoreTemperatureFloor
      : PAIRING_SAMPLING_DEFAULTS.scoreTemperatureFloor;
  const safeInterTeamEloScale =
    (typeof mergedOptions.interTeamEloScale === 'number'
      && Number.isFinite(mergedOptions.interTeamEloScale)
      && mergedOptions.interTeamEloScale > 0)
      ? mergedOptions.interTeamEloScale
      : PAIRING_SAMPLING_DEFAULTS.interTeamEloScale;
  const safeInterTeamEloStrength =
    (typeof mergedOptions.interTeamEloStrength === 'number'
      && Number.isFinite(mergedOptions.interTeamEloStrength)
      && mergedOptions.interTeamEloStrength >= 0)
      ? mergedOptions.interTeamEloStrength
      : PAIRING_SAMPLING_DEFAULTS.interTeamEloStrength;
  const safeMinCandidateWeight =
    (typeof mergedOptions.minCandidateWeight === 'number'
      && Number.isFinite(mergedOptions.minCandidateWeight)
      && mergedOptions.minCandidateWeight > 0)
      ? mergedOptions.minCandidateWeight
      : PAIRING_SAMPLING_DEFAULTS.minCandidateWeight;
  const scoreTemperature = Math.max(
    safeScoreTemperatureFloor,
    scoreSpread / safeScoreSpreadDivisor
  );
  const safeScoreTemperature = Number.isFinite(scoreTemperature) && scoreTemperature > 0
    ? scoreTemperature
    : safeScoreTemperatureFloor;

  return scoredCandidates.map(candidate => {
    const candidateScore = Number.isFinite(candidate?.score) ? candidate.score : minScore;
    const interTeamEloDiff = Number.isFinite(candidate?.interTeamEloDiff) && candidate.interTeamEloDiff >= 0
      ? candidate.interTeamEloDiff
      : 0;

    // Preserve repeat/waiting-karma priorities via softmax on the base score.
    const scoreFactor = Math.exp((candidateScore - maxScore) / safeScoreTemperature);
    // Bias towards lower Elo gap without turning it into a hard deterministic cut.
    const eloFactor = Math.exp(
      -(interTeamEloDiff / safeInterTeamEloScale) * safeInterTeamEloStrength
    );
    const rawWeight = scoreFactor * eloFactor;
    const normalizedWeight = Number.isFinite(rawWeight) && rawWeight >= 0
      ? rawWeight
      : safeMinCandidateWeight;
    const weight = Math.max(safeMinCandidateWeight, normalizedWeight);

    return {
      ...candidate,
      score: candidateScore,
      interTeamEloDiff,
      sampleWeight: weight,
    };
  });
}

function pickWeightedCandidate(weightedCandidates, randomValue) {
  if (!weightedCandidates.length) {
    return null;
  }

  const normalizedWeights = weightedCandidates.map(candidate => ({
    candidate,
    weight: (Number.isFinite(candidate?.sampleWeight) && candidate.sampleWeight > 0) ? candidate.sampleWeight : 0
  }));

  const totalWeight = normalizedWeights.reduce((sum, entry) => sum + entry.weight, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    return weightedCandidates[0];
  }

  const safeRandomValue = Number.isFinite(randomValue)
    ? Math.min(Math.max(randomValue, 0), 1 - Number.EPSILON)
    : 0;
  const target = safeRandomValue * totalWeight;
  let cumulative = 0;
  let lastPositiveCandidate = null;
  for (const entry of normalizedWeights) {
    cumulative += entry.weight;
    if (entry.weight > 0) {
      lastPositiveCandidate = entry.candidate;
    }
    if (target <= cumulative) {
      return entry.candidate;
    }
  }

  return lastPositiveCandidate || weightedCandidates[weightedCandidates.length - 1];
}

function buildSideCounts(matches) {
    const countA = {}, countB = {};
    matches.forEach(m => {
        m.teamA.forEach(p => {
            countA[p] = (countA[p] || 0) + 1;
            if (!(p in countB)) countB[p] = 0;
        });
        m.teamB.forEach(p => {
            countB[p] = (countB[p] || 0) + 1;
            if (!(p in countA)) countA[p] = 0;
        });
    });
    return { countA, countB };
}

function redCost(p, countA, countB) { return Math.abs(((countA[p] || 0) + 1) / ((countA[p] || 0) + (countB[p] || 0) + 1) - 0.5); }
function blueCost(p, countA, countB) { return Math.abs((countA[p] || 0) / ((countA[p] || 0) + (countB[p] || 0) + 1) - 0.5); }


// Main function to suggest and display pairing
export async function suggestPairing() {
  // Fetch active players (this remains a direct Firestore call as it's session-specific)
  const sessionDocRef = doc(db, 'meta', 'session');
  const sessDocSnap = await getDoc(sessionDocRef);
  const activePlayers = (sessDocSnap.exists() && sessDocSnap.data().activePlayers) || [];
  
  if (activePlayers.length < 4) {
      alert("Please select at least 4 active players to suggest a pairing.");
      return;
  }

  // The match data is already sorted by timestamp descending, so we reverse for chronological order.
  const chronologicalMatches = [...allMatches].reverse();
  const { session: sessionMatches, historic: historicMatches } = splitSession(chronologicalMatches);

  const playsCount = countPlaysPerPlayer(sessionMatches, activePlayers);
  const countsSession = buildCoAndOppCounts(sessionMatches, activePlayers);
  const countsHistoric = buildCoAndOppCounts(historicMatches, activePlayers);
  const waitingKarmaMap = computeWaitingKarma(sessionMatches, activePlayers, WAITING_KARMA_DEFAULTS);

  console.log("Waiting Karma Map:", waitingKarmaMap);

  const eloMap = {};
  activePlayers.forEach(playerId => {
    eloMap[playerId] = getSeasonElo(playerId);
  });

  const data = {
      playsCount,
      countsSession,
      countsHistoric,
  eloMap,
  waitingKarmaMap
  };

  const candidates = generatePairings(activePlayers);
  if (candidates.length === 0) {
      alert("Could not generate any pairings with the selected active players.");
      return;
  }

  const scored = candidates.map(p => {
    const { interDiff } = getPairingEloDiffs(p.teamA, p.teamB, data.eloMap);
    return {
      pairing: p,
      score: scorePairing(p, data),
      interTeamEloDiff: interDiff
    };
  });
  scored.sort((a, b) => b.score - a.score);

  // Sample one candidate with deterministic seeded randomness.
  // Base score keeps repeat/karma pressure; Elo gap shapes probabilities.
  // Use the active players + a session key as a seed for reproducibility across devices.
  // The session key changes between sessions (based on the first match in-session, or the latest match timestamp
  // when the session hasn't started yet), so the same active players can yield a different first suggestion
  // in a new session.
  const sessionStartTimestamp = (sessionMatches.length > 0 && typeof sessionMatches[0].timestamp === 'number')
    ? sessionMatches[0].timestamp
    : null;

  const latestMatchTimestamp = (chronologicalMatches.length > 0 && typeof chronologicalMatches[chronologicalMatches.length - 1].timestamp === 'number')
    ? chronologicalMatches[chronologicalMatches.length - 1].timestamp
    : null;

  const sessionSeedKey = sessionStartTimestamp ?? latestMatchTimestamp ?? 0;
  const seedPlayers = [...activePlayers].sort().join(',');
  const seedInput = `${seedPlayers}|${sessionSeedKey}`;

  // Create a simple hash from active players + session key to use as seed
  const seed = seedInput.split('').reduce((acc, char) => {
    return ((acc << 5) - acc) + char.charCodeAt(0) | 0;
  }, 0);
  
  // Seeded random number generator (deterministic)
  const seededRandom = (seed) => {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  };

  const randomValue = seededRandom(seed + sessionMatches.length);
  const weightedCandidates = buildSamplingWeights(scored, PAIRING_SAMPLING_DEFAULTS);
  const chosen = pickWeightedCandidate(weightedCandidates, randomValue) || weightedCandidates[0];
  const best = chosen.pairing;
  const { countA, countB } = buildSideCounts(chronologicalMatches);
  const { teamA, teamB } = best;

  const cost1 = teamA.reduce((sum, p) => sum + redCost(p, countA, countB), 0) + teamB.reduce((sum, p) => sum + blueCost(p, countA, countB), 0);
  const cost2 = teamA.reduce((sum, p) => sum + blueCost(p, countA, countB), 0) + teamB.reduce((sum, p) => sum + redCost(p, countA, countB), 0);

  const [redTeam, blueTeam] = (cost1 <= cost2) ? [teamA, teamB] : [teamB, teamA];

  teamA1Select.value = redTeam[0];
  teamA2Select.value = redTeam[1];
  teamB1Select.value = blueTeam[0];
  teamB2Select.value = blueTeam[1];

  notifyRolesChanged();

  storeLastSuggestion(redTeam, blueTeam, activePlayers);
}
