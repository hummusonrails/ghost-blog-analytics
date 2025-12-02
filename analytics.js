import "dotenv/config";
import crypto from "crypto";
import { writeFile } from "fs/promises";

const GHOST_ADMIN_URL = process.env.GHOST_URL || process.env.GHOST_ADMIN_URL;
const GHOST_ADMIN_KEY = process.env.GHOST_ADMIN_KEY;
const TIMEZONE = process.env.TIMEZONE || "Etc/UTC";

if (!GHOST_ADMIN_URL || !GHOST_ADMIN_KEY) {
  console.error("Set GHOST_URL (or GHOST_ADMIN_URL) and GHOST_ADMIN_KEY env vars first");
  process.exit(1);
}

function generateAdminJwt(adminKey) {
  const [id, secret] = adminKey.split(":");
  if (!id || !secret) {
    throw new Error("Invalid GHOST_ADMIN_KEY format, expected id:secret");
  }

  const header = {
    alg: "HS256",
    typ: "JWT",
    kid: id
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now,
    exp: now + 5 * 60,
    aud: "/admin/"
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const unsigned = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac("sha256", Buffer.from(secret, "hex"))
    .update(unsigned)
    .digest("base64url");

  return `${unsigned}.${signature}`;
}

async function ghostAdminRequest(endpoint, options = {}) {
  const token = generateAdminJwt(GHOST_ADMIN_KEY);
  const url = `${GHOST_ADMIN_URL.replace(/\/$/, "")}/ghost/api/admin${endpoint}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Ghost ${token}`,
      "Accept": "application/json",
      "Accept-Version": "v5.0",
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ghost API ${res.status}: ${text}`);
  }

  return res.json();
}

function getDateRangeMonthsBack(monthsBack) {
  const now = new Date();
  const end = now.toISOString().slice(0, 10); // YYYY-MM-DD

  const start = new Date(now);
  start.setMonth(start.getMonth() - monthsBack);
  const startStr = start.toISOString().slice(0, 10);

  return { startStr, endStr: end };
}

async function getTinybirdToken() {
  const data = await ghostAdminRequest("/tinybird/token/", { method: "GET" });

  const token = data.token || (data.tinybird && data.tinybird.token) || null;

  if (!token) {
    throw new Error(
      "token response missing token. Raw: " +
      JSON.stringify(data)
    );
  }

  // decode the JWT payload to extract site_uuid from scopes.fixed_params.site_uuid
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format");
  }

  const payloadJson = JSON.parse(
    Buffer.from(parts[1], "base64").toString("utf8")
  );

  let siteUUID = null;

  if (Array.isArray(payloadJson.scopes)) {
    for (const scope of payloadJson.scopes) {
      if (scope.fixed_params && scope.fixed_params.site_uuid) {
        siteUUID = scope.fixed_params.site_uuid;
        break;
      }
    }
  }

  if (!siteUUID) {
    throw new Error(
      "Could not derive site_uuid from token payload. Payload: " +
      JSON.stringify(payloadJson)
    );
  }

  return { tinybirdToken: token, siteUUID };
}

async function getPostsLast12Months() {
  const { startStr, endStr } = getDateRangeMonthsBack(12);

  // filter the posts published in the last 12 months
  const filter = `published_at:>='${startStr}'`;

  const data = await ghostAdminRequest(
    `/posts/?limit=all&fields=id,uuid,title,slug,published_at&filter=${encodeURIComponent(filter)}`,
    { method: "GET" }
  );

  return data.posts || [];
}

async function getPostKpisForPeriod(siteUUID, tinybirdToken, postUUID, startStr, endStr) {
  const url = new URL("https://api.tinybird.co/v0/pipes/api_kpis.json");
  url.searchParams.set("site_uuid", siteUUID);
  url.searchParams.set("date_from", startStr);
  url.searchParams.set("date_to", endStr);
  url.searchParams.set("timezone", TIMEZONE);
  url.searchParams.set("post_uuid", postUUID);
  url.searchParams.set("from", "script");
  url.searchParams.set("token", tinybirdToken);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Accept": "application/json"
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`api_kpis error ${res.status}: ${text}`);
  }

  const json = await res.json();
  // json.data is an array of rows: { date, visits, pageviews, ... }
  return json.data || [];
}

// a simplistic CSV escaping, not perfect but it'll do
function escapeCsv(val) {
  if (val === null || val === undefined) return "";
  const str = String(val);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

(async () => {
  try {
    const { startStr, endStr } = getDateRangeMonthsBack(12);
    console.log(`Analyzing ${startStr} to ${endStr}`);

    const posts = await getPostsLast12Months();
    console.log(`Found ${posts.length} posts in last 12 months`);

    const { tinybirdToken, siteUUID } = await getTinybirdToken();

    const aggregateResults = [];
    const dailyResults = [];

    const now = new Date();

    for (const post of posts) {
      if (!post.uuid) continue;

      const publishedAt = post.published_at ? new Date(post.published_at) : null;
      if (!publishedAt || Number.isNaN(publishedAt.getTime())) {
        console.warn(`Skipping post without valid published_at: ${post.slug || post.uuid}`);
        continue;
      }

      const baselineStart = new Date(`${startStr}T00:00:00Z`);
      const effectiveStart = new Date(Math.max(baselineStart.getTime(), publishedAt.getTime()));
      const effectiveStartStr = effectiveStart.toISOString().slice(0, 10);

      const rows = await getPostKpisForPeriod(
        siteUUID,
        tinybirdToken,
        post.uuid,
        effectiveStartStr,
        endStr
      );

      let totalPageviews = 0;
      let totalVisits = 0;

      let first7Pageviews = 0;
      let first7Visits = 0;

      // Ignore any rows before the post was published (the data likes to give back 0s for this for some reason)
      const filteredRows = rows.filter((row) => {
        if (!row.date) return true;
        return row.date >= effectiveStartStr;
      });

      for (const row of filteredRows) {
        const dayDate = new Date(row.date);

        const pv = Number(row.pageviews || 0);
        const vs = Number(row.visits || 0);

        totalPageviews += pv;
        totalVisits += vs;

        // Diff in days between this date and published_at
        const diffMs = dayDate.getTime() - publishedAt.getTime();
        const diffDays = diffMs / (1000 * 60 * 60 * 24);

        if (diffDays >= 0 && diffDays < 7) {
          first7Pageviews += pv;
          first7Visits += vs;
        }

        // Collect daily data row
        dailyResults.push({
          post_title: post.title,
          post_slug: post.slug,
          post_uuid: post.uuid,
          published_at: post.published_at,
          date: row.date,
          pageviews: pv,
          visits: vs
        });
      }

      const ageDaysRaw = (now.getTime() - publishedAt.getTime()) / (1000 * 60 * 60 * 24);
      const ageDays = Math.max(1, Math.floor(ageDaysRaw));

      const pageviewsAfter7d = Math.max(0, totalPageviews - first7Pageviews);
      const visitsAfter7d = Math.max(0, totalVisits - first7Visits);
      const tailDays = Math.max(1, ageDays - 7);

      const viewsPerDayTotal = totalPageviews / ageDays;
      const viewsPerDayFirst7 = first7Pageviews / Math.min(7, ageDays);
      const viewsPerDayAfter7 = pageviewsAfter7d / tailDays;

      aggregateResults.push({
        title: post.title,
        slug: post.slug,
        uuid: post.uuid,
        published_at: post.published_at,
        age_days: ageDays,
        pageviews_total: totalPageviews,
        visits_total: totalVisits,
        pageviews_7d: first7Pageviews,
        visits_7d: first7Visits,
        pageviews_after_7d: pageviewsAfter7d,
        visits_after_7d: visitsAfter7d,
        views_per_day_total: viewsPerDayTotal,
        views_per_day_7d: viewsPerDayFirst7,
        views_per_day_after_7d: viewsPerDayAfter7
      });
    }

    aggregateResults.sort((a, b) => b.pageviews_total - a.pageviews_total);

    console.table(
      aggregateResults,
      [
        "title",
        "published_at",
        "age_days",
        "pageviews_total",
        "pageviews_7d",
        "pageviews_after_7d",
        "views_per_day_total",
        "views_per_day_7d",
        "views_per_day_after_7d"
      ]
    );

    // Write aggregate CSV
    const aggregateHeaders = [
      "title",
      "slug",
      "uuid",
      "published_at",
      "age_days",
      "pageviews_total",
      "visits_total",
      "pageviews_7d",
      "visits_7d",
      "pageviews_after_7d",
      "visits_after_7d",
      "views_per_day_total",
      "views_per_day_7d",
      "views_per_day_after_7d"
    ];

    const aggregateLines = [
      aggregateHeaders.join(","),
      ...aggregateResults.map(row =>
        aggregateHeaders.map(h => escapeCsv(row[h])).join(",")
      )
    ];

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const aggregateFilename = `analytics-aggregate-${timestamp}.csv`;
    await writeFile(aggregateFilename, aggregateLines.join("\n"), "utf8");
    console.log(`Saved aggregate CSV to ${aggregateFilename}`);

    // Write daily CSV
    const dailyHeaders = [
      "post_title",
      "post_slug",
      "post_uuid",
      "published_at",
      "date",
      "pageviews",
      "visits"
    ];

    const dailyLines = [
      dailyHeaders.join(","),
      ...dailyResults.map(row =>
        dailyHeaders.map(h => escapeCsv(row[h])).join(",")
      )
    ];

    const dailyFilename = `analytics-daily-${timestamp}.csv`;
    await writeFile(dailyFilename, dailyLines.join("\n"), "utf8");
    console.log(`Saved daily CSV to ${dailyFilename}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
