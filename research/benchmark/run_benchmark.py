#!/usr/bin/env python3
"""
200-Site AI Agent-Readiness Benchmark Runner

Uses CBrowser's agent-ready-audit tool via CLI with residential proxies
from 3 US regions (us-west, us-east, us-central) in round-robin.
"""

import subprocess
import json
import time
import sys
import os
from pathlib import Path

# 200 sites — recognizable brands across 41 industries
# Replaced 19 less-known sites with household names
SITES = {
    # AI & Productivity (7)
    "cbrowser.ai": "AI", "claude.ai": "AI", "perplexity.ai": "AI",
    "chatgpt.com": "AI", "canva.com": "AI", "figma.com": "AI", "anthropic.com": "AI",
    # E-commerce (3)
    "etsy.com": "E-commerce", "amazon.com": "E-commerce", "walmart.com": "E-commerce",
    # SaaS (9)
    "stripe.com": "SaaS", "slack.com": "SaaS", "zapier.com": "SaaS",
    "trello.com": "SaaS", "dropbox.com": "SaaS", "github.com": "SaaS",
    "asana.com": "SaaS", "notion.so": "SaaS", "zoom.us": "SaaS",
    # Media & News (10)
    "imdb.com": "Media", "medium.com": "Media", "reuters.com": "Media",
    "bloomberg.com": "Media", "cnn.com": "Media", "goodreads.com": "Media",
    "reddit.com": "Media", "foxnews.com": "Media", "theguardian.com": "Media",
    "nytimes.com": "Media",
    # Healthcare (6)
    "webmd.com": "Healthcare", "cvs.com": "Healthcare", "mayoclinic.org": "Healthcare",
    "walgreens.com": "Healthcare", "cigna.com": "Healthcare", "unitedhealth.com": "Healthcare",
    # Finance (6)
    "progressive.com": "Finance", "chase.com": "Finance", "wellsfargo.com": "Finance",
    "geico.com": "Finance", "bankofamerica.com": "Finance", "capitalone.com": "Finance",
    # Fintech (9)
    "venmo.com": "Fintech", "coinbase.com": "Fintech", "opensea.io": "Fintech",
    "uniswap.org": "Fintech", "kraken.com": "Fintech", "etrade.com": "Fintech",
    "robinhood.com": "Fintech", "paypal.com": "Fintech", "binance.com": "Fintech",
    # Government (2)
    "gov.uk": "Government", "usa.gov": "Government",
    # Education (6)
    "udemy.com": "Education", "masterclass.com": "Education", "wikipedia.org": "Education",
    "coursera.org": "Education", "khanacademy.org": "Education", "duolingo.com": "Education",
    # Travel (8)
    "tripadvisor.com": "Travel", "hyatt.com": "Travel", "expedia.com": "Travel",
    "priceline.com": "Travel", "marriott.com": "Travel", "hilton.com": "Travel",
    "airbnb.com": "Travel", "booking.com": "Travel",
    # Social (8)
    "meta.com": "Social", "x.com": "Social", "pinterest.com": "Social",
    "tiktok.com": "Social", "discord.com": "Social", "threads.net": "Social",
    "linkedin.com": "Social", "whatsapp.com": "Social",
    # Food (4)
    "doordash.com": "Food", "ubereats.com": "Food", "dominos.com": "Food",
    "grubhub.com": "Food",
    # Streaming (7)
    "spotify.com": "Streaming", "hulu.com": "Streaming", "disneyplus.com": "Streaming",
    "netflix.com": "Streaming", "twitch.tv": "Streaming", "max.com": "Streaming",
    "youtube.com": "Streaming",
    # DevTools (8)
    "replit.com": "DevTools", "grammarly.com": "DevTools", "supabase.com": "DevTools",
    "netlify.com": "DevTools", "vercel.com": "DevTools", "render.com": "DevTools",
    "gitlab.com": "DevTools", "cloudflare.com": "DevTools",
    # Retail (12)
    "homedepot.com": "Retail", "lowes.com": "Retail", "petco.com": "Retail",
    "ikea.com": "Retail", "costco.com": "Retail", "macys.com": "Retail",
    "chewy.com": "Retail", "wayfair.com": "Retail", "kohls.com": "Retail",
    "bestbuy.com": "Retail", "ebay.com": "Retail", "target.com": "Retail",
    # Fashion (8)
    "gap.com": "Fashion", "sephora.com": "Fashion", "ulta.com": "Fashion",
    "zara.com": "Fashion", "hm.com": "Fashion", "asos.com": "Fashion",
    "adidas.com": "Fashion", "nordstrom.com": "Fashion",
    # Automotive (3)
    "tesla.com": "Automotive", "bmw.com": "Automotive", "toyota.com": "Automotive",
    # Real Estate (5)
    "apartments.com": "Real Estate", "zillow.com": "Real Estate", "redfin.com": "Real Estate",
    "trulia.com": "Real Estate", "realtor.com": "Real Estate",
    # Fitness (4)
    "myfitnesspal.com": "Fitness", "nike.com": "Fitness", "headspace.com": "Fitness",
    "peloton.com": "Fitness",
    # Gaming (4)
    "epicgames.com": "Gaming", "xbox.com": "Gaming", "store.steampowered.com": "Gaming",
    "playstation.com": "Gaming",
    # Airlines (2)
    "delta.com": "Airlines", "southwest.com": "Airlines",
    # Grocery (2)
    "instacart.com": "Grocery", "wholefoodsmarket.com": "Grocery",
    # Cloud (4)
    "salesforce.com": "Cloud", "atlassian.com": "Cloud", "cloud.google.com": "Cloud",
    "aws.amazon.com": "Cloud",
    # Telecom (4)
    "t-mobile.com": "Telecom", "xfinity.com": "Telecom", "att.com": "Telecom",
    "verizon.com": "Telecom",
    # Restaurant (4)
    "starbucks.com": "Restaurant", "chipotle.com": "Restaurant",
    "mcdonalds.com": "Restaurant", "chick-fil-a.com": "Restaurant",
    # Sports (4)
    "espn.com": "Sports", "ticketmaster.com": "Sports",
    "stubhub.com": "Sports", "nba.com": "Sports",
    # Dating (4)
    "match.com": "Dating", "tinder.com": "Dating", "bumble.com": "Dating",
    "hinge.co": "Dating",
    # Logistics (2)
    "fedex.com": "Logistics", "usps.com": "Logistics",
    # Enterprise (5)
    "servicenow.com": "Enterprise", "zendesk.com": "Enterprise",
    "hubspot.com": "Enterprise", "webflow.com": "Enterprise", "monday.com": "Enterprise",
    # Tech Giant (4)
    "apple.com": "Tech Giant", "microsoft.com": "Tech Giant",
    "google.com": "Tech Giant", "samsung.com": "Tech Giant",
    # Web Builder (4)
    "godaddy.com": "Web Builder", "squarespace.com": "Web Builder",
    "wix.com": "Web Builder", "shopify.com": "Web Builder",
    # Security (4)
    "nordvpn.com": "Security", "1password.com": "Security",
    "okta.com": "Security", "lastpass.com": "Security",
    # Services (3)
    "yelp.com": "Services", "rover.com": "Services", "care.com": "Services",
    # Events (3)
    "livenation.com": "Events", "eventbrite.com": "Events", "meetup.com": "Events",
    # Electronics (3)
    "bhphotovideo.com": "Electronics", "sonos.com": "Electronics", "newegg.com": "Electronics",
    # Non-profit (4)
    "redcross.org": "Non-profit", "stackoverflow.com": "Non-profit",
    "allrecipes.com": "Non-profit", "wikipedia.org": "Non-profit",
    # Jobs (4)
    "indeed.com": "Jobs", "glassdoor.com": "Jobs",
    "ziprecruiter.com": "Jobs", "workday.com": "Jobs",
    # Beverages (4)
    "pepsi.com": "Beverages", "coca-cola.com": "Beverages",
    "redbull.com": "Beverages", "monsterenergy.com": "Beverages",
    # Marketplace (3)
    "aliexpress.com": "Marketplace", "wish.com": "Marketplace", "mercari.com": "Marketplace",
    # Outdoor (2)
    "patagonia.com": "Outdoor", "rei.com": "Outdoor",
    # Messaging (2)
    "signal.org": "Messaging", "docusign.com": "Messaging",
}

US_REGIONS = ["us-west", "us-east", "us-central"]

def run_audit(url, region, timeout=90):
    """Run agent-ready-audit via CBrowser CLI with geo proxy."""
    output_file = f"/tmp/audit_{url.replace('/', '_').replace('.', '_')}.json"
    cmd = [
        "node", "dist/cli.js", "agent-ready-audit",
        f"https://{url}",
        "--geo-region", region,
        "--output", output_file,
    ]
    try:
        subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
            cwd=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
        )
        if os.path.exists(output_file):
            with open(output_file) as f:
                data = json.load(f)
            os.remove(output_file)
            return data
        return None
    except subprocess.TimeoutExpired:
        return None
    except Exception:
        return None


def extract_score(audit_result):
    """Extract grade and score from audit result."""
    if not audit_result:
        return None, None

    grade = audit_result.get("grade")
    score_obj = audit_result.get("score", {})

    if isinstance(score_obj, dict):
        score = score_obj.get("overall")
    elif isinstance(score_obj, (int, float)):
        score = score_obj
    else:
        score = None

    if score is not None:
        score = int(round(float(score)))

    if grade is None and score is not None:
        if score >= 90: grade = "A"
        elif score >= 80: grade = "B"
        elif score >= 70: grade = "C"
        elif score >= 60: grade = "D"
        else: grade = "F"

    return grade, score


def main():
    output_dir = Path(__file__).parent / "results"
    output_dir.mkdir(exist_ok=True)

    sites = list(SITES.items())
    total = len(sites)

    # Deduplicate (wikipedia.org appears twice)
    seen = set()
    unique_sites = []
    for url, industry in sites:
        if url not in seen:
            seen.add(url)
            unique_sites.append((url, industry))
    sites = unique_sites
    total = len(sites)

    print(f"Running agent-ready-audit on {total} sites")
    print(f"Proxy regions: {US_REGIONS}")
    print(f"{'='*60}")

    results = []
    failed = []
    t_start = time.time()

    for i, (url, industry) in enumerate(sites):
        region = US_REGIONS[i % len(US_REGIONS)]

        t0 = time.time()
        audit = run_audit(url, region)
        elapsed = time.time() - t0

        grade, score = extract_score(audit)

        if grade and score:
            results.append({
                "site": url.split(".")[0].replace("www.", "").title() if "." in url else url,
                "url": url,
                "industry": industry,
                "grade": grade,
                "score": score,
                "region": region,
            })
            status = f"{grade} ({score})"
        else:
            failed.append(url)
            status = "FAILED"

        if (i + 1) % 5 == 0 or i == 0:
            eta = ((time.time() - t_start) / (i + 1)) * (total - i - 1)
            print(f"  [{i+1}/{total}] {url} → {status} ({elapsed:.1f}s, via {region}, ETA {eta/60:.0f}m)")

        # Brief pause between requests
        time.sleep(1)

    # Save results
    with open(output_dir / "benchmark_results.json", "w") as f:
        json.dump({"results": results, "failed": failed, "total": total, "timestamp": time.strftime("%Y-%m-%d %H:%M:%S")}, f, indent=2)

    print(f"\n{'='*60}")
    print(f"Completed: {len(results)}/{total} sites scored, {len(failed)} failed")
    print(f"Time: {(time.time() - t_start)/60:.1f} minutes")
    print(f"Results: {output_dir / 'benchmark_results.json'}")

    if failed:
        print(f"\nFailed sites: {', '.join(failed)}")


if __name__ == "__main__":
    main()
