(function attachExpediaEvcExtractor(root) {
  "use strict";

  const HEADER_ALIASES = {
    guest: ["guest", "guest name", "traveler", "traveler name"],
    reservationId: ["reservation", "reservation id", "itinerary", "itinerary id"],
    checkIn: ["check-in", "check in", "arrival", "arrival date"],
    status: ["status", "card status", "virtual card status"],
    remainingBalance: ["remaining balance", "available balance", "balance"],
    refundAmount: ["refund amount", "amount to refund", "refund", "amount"]
  };

  function clean(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function canonical(value) {
    return clean(value).toLowerCase().replace(/[?:]/g, "");
  }

  function findHeaderIndex(headers, field) {
    const aliases = HEADER_ALIASES[field];
    return headers.findIndex((header) => aliases.includes(canonical(header)));
  }

  function classifySection(label, headers) {
    const text = canonical(label);
    if (text.includes("refund")) return "refund_due";
    if (text.includes("ready to charge") || text.includes("charge")) return "ready_to_charge";
    if (findHeaderIndex(headers, "remainingBalance") >= 0) return "ready_to_charge";
    return null;
  }

  function moneyFromText(value) {
    const match = clean(value).match(/(?:[A-Z]{3}\s*)?\$?\s*[0-9]+(?:,[0-9]{3})*\.\d{2}(?:\s*[A-Z]{3})?/);
    return match ? clean(match[0]) : "";
  }

  function extractOriginalPayout(detailRows) {
    for (const detail of detailRows || []) {
      const text = clean(detail);
      if (/original payout/i.test(text)) return moneyFromText(text);
    }
    return "";
  }

  function extractTable(table, warnings) {
    const headers = (table.headers || []).map(clean);
    const queue = classifySection(table.sectionLabel || table.caption || table.ariaLabel, headers);
    if (!queue) return [];

    const guestIndex = findHeaderIndex(headers, "guest");
    const reservationIndex = findHeaderIndex(headers, "reservationId");
    const amountIndex = findHeaderIndex(headers, queue === "refund_due" ? "refundAmount" : "remainingBalance");
    const checkInIndex = findHeaderIndex(headers, "checkIn");
    const statusIndex = findHeaderIndex(headers, "status");
    const missing = [];
    if (guestIndex < 0) missing.push("guest");
    if (reservationIndex < 0) missing.push("reservationId");
    if (amountIndex < 0) missing.push(queue === "refund_due" ? "refundAmount" : "remainingBalance");
    if (missing.length) {
      warnings.push(`${queue} table missing required headers: ${missing.join(", ")}`);
      return [];
    }

    const records = [];
    for (const row of table.rows || []) {
      const cells = row.cells || [];
      if (row.isDetail || cells.length === 1) continue;
      const record = {
        queue,
        guest: clean(cells[guestIndex]),
        reservationId: clean(cells[reservationIndex]),
        amount: clean(cells[amountIndex]),
        checkIn: checkInIndex >= 0 ? clean(cells[checkInIndex]) : "",
        status: statusIndex >= 0 ? clean(cells[statusIndex]) : ""
      };
      if (queue === "ready_to_charge") record.originalPayout = extractOriginalPayout(row.detailRows);
      records.push(record);
    }
    return records;
  }

  function extractSnapshot(snapshot, pageNumber = 1) {
    const warnings = [];
    const tables = Array.isArray(snapshot.tables) ? snapshot.tables : [];
    const records = tables.flatMap((table) => extractTable(table, warnings));
    const detectedQueues = new Set(tables.map((table) => classifySection(table.sectionLabel || table.caption || table.ariaLabel, table.headers || [])).filter(Boolean));
    for (const queue of ["ready_to_charge", "refund_due"]) {
      if (!detectedQueues.has(queue)) warnings.push(`Required section not found: ${queue}`);
    }
    const expectedCounts = snapshot.expectedCounts || {};
    const expectedCount = Number.isInteger(expectedCounts.total)
      ? expectedCounts.total
      : [expectedCounts.ready_to_charge, expectedCounts.refund_due].every(Number.isInteger)
        ? expectedCounts.ready_to_charge + expectedCounts.refund_due
        : null;
    if (expectedCount === null) warnings.push("Displayed result count was not found");
    if (!snapshot.property || !clean(snapshot.property.id) || !clean(snapshot.property.name)) warnings.push("Property identity was not verified");

    return {
      extractionVersion: "1.0.0",
      pageNumber,
      status: warnings.length ? "incomplete" : "complete",
      property: snapshot.property || null,
      expectedCount,
      pagination: snapshot.pagination || { hasNext: false, range: null },
      warnings,
      records
    };
  }

  function nearestSectionLabel(table) {
    const explicit = table.getAttribute("aria-label") || table.caption?.textContent;
    if (clean(explicit)) return clean(explicit);
    let cursor = table;
    for (let depth = 0; cursor && depth < 8; depth += 1, cursor = cursor.parentElement) {
      const heading = cursor.querySelector?.("h1, h2, h3, h4, [role='heading']");
      if (heading && clean(heading.textContent)) return clean(heading.textContent);
      let sibling = cursor.previousElementSibling;
      while (sibling) {
        if (sibling.matches?.("h1, h2, h3, h4, [role='heading']")) return clean(sibling.textContent);
        sibling = sibling.previousElementSibling;
      }
    }
    return "";
  }

  function tableToSnapshot(table) {
    const allRows = [...table.rows];
    const headerRow = allRows.find((row) => row.querySelector("th")) || allRows[0];
    const headers = headerRow ? [...headerRow.cells].map((cell) => clean(cell.textContent)) : [];
    const rows = [];
    let lastRecord = null;
    for (const row of allRows) {
      if (row === headerRow) continue;
      const nested = row.querySelector("table");
      const cells = [...row.cells].map((cell) => clean(cell.textContent));
      if (nested || cells.length === 1) {
        if (lastRecord) lastRecord.detailRows.push(clean(row.textContent));
        continue;
      }
      lastRecord = { cells, detailRows: [] };
      rows.push(lastRecord);
    }
    return { sectionLabel: nearestSectionLabel(table), headers, rows };
  }

  function readText(rootNode, selectors) {
    for (const selector of selectors) {
      const node = rootNode.querySelector(selector);
      if (node && clean(node.textContent || node.value)) return clean(node.textContent || node.value);
    }
    return "";
  }

  function parseDisplayedCounts(text) {
    const counts = {};
    const total = clean(text).match(/(?:of|total)\s+([0-9,]+)\s+(?:results?|records?)/i);
    if (total) counts.total = Number(total[1].replaceAll(",", ""));
    return counts;
  }

  function extractDocument(document, pageNumber = 1) {
    const bodyText = clean(document.body?.textContent);
    const propertyId = document.querySelector("[data-property-id]")?.getAttribute("data-property-id") || new URL(document.location?.href || "https://invalid.local").searchParams.get("htid") || "";
    const propertyName = readText(document, ["[data-testid='property-name']", "[data-property-name]", "[aria-label*='property' i]"]);
    const nextButton = [...document.querySelectorAll("button")].find((button) => /next records|next/i.test(clean(button.textContent || button.getAttribute("aria-label"))));
    const snapshot = {
      property: { id: clean(propertyId), name: propertyName },
      expectedCounts: parseDisplayedCounts(bodyText),
      pagination: {
        hasNext: Boolean(nextButton && !nextButton.disabled && nextButton.getAttribute("aria-disabled") !== "true"),
        range: bodyText.match(/\b[0-9,]+\s*[-–]\s*[0-9,]+\s+of\s+[0-9,]+\b/i)?.[0] || null
      },
      tables: [...document.querySelectorAll("table")].map(tableToSnapshot)
    };
    return extractSnapshot(snapshot, pageNumber);
  }

  const api = { extractDocument, extractSnapshot };
  root.ExpediaEvcExtractor = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
