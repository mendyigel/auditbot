'use strict';

/**
 * monitor.js — Site monitoring scheduler.
 *
 * Periodically checks monitored_sites that are due for an audit,
 * runs audits, saves snapshots, detects changes, and triggers notifications.
 *
 * Uses node-cron for scheduling. Concurrency-limited to avoid self-DoS.
 */

const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { auditUrl } = require('./auditor');
const { benchmarkCompetitors } = require('./competitor');
const emailService = require('./email');

const MAX_CONCURRENT = parseInt(process.env.MONITOR_CONCURRENCY, 10) || 2;
const CHECK_INTERVAL_MIN = parseInt(process.env.MONITOR_CHECK_INTERVAL_MIN, 10) || 15;
const MAX_SITES_PER_USER = 5;
const MAX_CONSECUTIVE_FAILURES = 3;

let running = false;
let activeJobs = 0;

/**
 * Start the monitoring scheduler.
 * Runs every CHECK_INTERVAL_MIN minutes.
 */
function startScheduler() {
  console.log(`[monitor] Scheduler starting — checking every ${CHECK_INTERVAL_MIN} min, max ${MAX_CONCURRENT} concurrent`);

  cron.schedule(`*/${CHECK_INTERVAL_MIN} * * * *`, async () => {
    if (running) {
      console.log('[monitor] Previous check still running, skipping');
      return;
    }
    running = true;
    try {
      await processDueSites();
    } catch (err) {
      console.error('[monitor] Scheduler error:', err.message);
    } finally {
      running = false;
    }
  });
}

/**
 * Process all sites that are due for a monitoring audit.
 */
async function processDueSites() {
  const dueSites = db.getDueSites(20);
  if (dueSites.length === 0) return;

  console.log(`[monitor] ${dueSites.length} site(s) due for audit`);

  const queue = [...dueSites];

  async function processNext() {
    if (queue.length === 0) return;
    const site = queue.shift();
    activeJobs++;
    try {
      await runMonitoringAudit(site);
    } catch (err) {
      console.error(`[monitor] Error auditing ${site.url}:`, err.message);
    } finally {
      activeJobs--;
      await processNext();
    }
  }

  // Start up to MAX_CONCURRENT workers
  const workers = [];
  for (let i = 0; i < Math.min(MAX_CONCURRENT, queue.length); i++) {
    workers.push(processNext());
  }
  await Promise.all(workers);
}

/**
 * Run a single monitoring audit for a site.
 * Saves a snapshot and compares with the previous one.
 */
async function runMonitoringAudit(site) {
  console.log(`[monitor] Auditing ${site.url} (site ${site.id})`);

  // Run audit
  const audit = await auditUrl(site.url);

  if (audit.error) {
    console.error(`[monitor] Audit failed for ${site.url}: ${audit.error}`);
    // TODO: track consecutive failures and disable after MAX_CONSECUTIVE_FAILURES
    db.updateSiteNextRun(site.id, site.frequency);
    return;
  }

  // Run competitor audits if configured
  let competitorScores = {};
  if (site.competitorUrls && site.competitorUrls.length > 0) {
    try {
      const compResults = await benchmarkCompetitors(site.url, site.competitorUrls);
      if (compResults && compResults.competitors) {
        for (const comp of compResults.competitors) {
          competitorScores[comp.url] = {
            seo: comp.scores?.seo || 0,
            performance: comp.scores?.performance || 0,
            accessibility: comp.scores?.accessibility || 0,
          };
        }
      }
    } catch (err) {
      console.error(`[monitor] Competitor audit error for ${site.url}:`, err.message);
    }
  }

  // Extract scores from audit
  const seoScore = audit.scores?.seo ?? audit.seoScore ?? 0;
  const performanceScore = audit.scores?.performance ?? audit.performanceScore ?? 0;
  const accessibilityScore = audit.scores?.accessibility ?? audit.accessibilityScore ?? 0;
  const overallScore = Math.round((seoScore + performanceScore + accessibilityScore) / 3);

  // Get previous snapshot for comparison
  const previousSnapshot = db.getLatestSnapshot(site.id);

  // Save new snapshot
  const snapshotId = uuidv4();
  db.saveSnapshot({
    id: snapshotId,
    monitoredSiteId: site.id,
    reportId: null,
    seoScore,
    performanceScore,
    accessibilityScore,
    overallScore,
    issues: audit.issues || [],
    competitorScores,
  });

  // Detect changes and send notifications
  if (previousSnapshot) {
    await detectChangesAndNotify(site, {
      seoScore, performanceScore, accessibilityScore, overallScore,
      issues: audit.issues || [], competitorScores,
    }, previousSnapshot);
  }

  // Update next run time
  db.updateSiteNextRun(site.id, site.frequency);

  console.log(`[monitor] Completed audit for ${site.url} — overall: ${overallScore}`);
}

/**
 * Compare current audit with previous snapshot and send notifications.
 */
async function detectChangesAndNotify(site, current, previous) {
  const notifyOn = site.notifyOn || {};

  // Score drop > 5 points
  if (notifyOn.score_drop) {
    const categories = [
      { name: 'SEO', curr: current.seoScore, prev: previous.seoScore },
      { name: 'Performance', curr: current.performanceScore, prev: previous.performanceScore },
      { name: 'Accessibility', curr: current.accessibilityScore, prev: previous.accessibilityScore },
    ];

    for (const cat of categories) {
      if (cat.prev - cat.curr > 5) {
        try {
          await emailService.sendMonitoringAlert({
            type: 'score_drop',
            siteUrl: site.url,
            category: cat.name,
            oldScore: cat.prev,
            newScore: cat.curr,
            userId: site.userId,
          });
        } catch (err) {
          console.error(`[monitor] Failed to send score drop alert:`, err.message);
        }
      }
    }
  }

  // Score improvement > 10 points
  const overallImprovement = current.overallScore - previous.overallScore;
  if (overallImprovement > 10) {
    try {
      await emailService.sendMonitoringAlert({
        type: 'score_improvement',
        siteUrl: site.url,
        oldScore: previous.overallScore,
        newScore: current.overallScore,
        userId: site.userId,
      });
    } catch (err) {
      console.error(`[monitor] Failed to send improvement alert:`, err.message);
    }
  }

  // Competitor overtake
  if (notifyOn.competitor_change && Object.keys(current.competitorScores).length > 0) {
    for (const [compUrl, compScores] of Object.entries(current.competitorScores)) {
      const prevComp = previous.competitorScores?.[compUrl];
      if (!prevComp) continue;

      // Check if competitor overtook user in any category
      if (compScores.seo > current.seoScore && (!prevComp || prevComp.seo <= previous.seoScore)) {
        try {
          await emailService.sendMonitoringAlert({
            type: 'competitor_overtake',
            siteUrl: site.url,
            competitorUrl: compUrl,
            category: 'SEO',
            userId: site.userId,
          });
        } catch (err) {
          console.error(`[monitor] Failed to send competitor alert:`, err.message);
        }
      }
    }
  }
}

module.exports = {
  startScheduler,
  processDueSites,
  runMonitoringAudit,
  MAX_SITES_PER_USER,
};
