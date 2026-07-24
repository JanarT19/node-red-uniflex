// idu-gateway-map.js
// Runtime helpers for IDU gateway map rows (stored in node config mapRows, not here).
// Zone names: perton/uistatus (liv = UI elu row, bed = UI mag row).
// CBS memberBase 1=liv, 7=bed.

const COOL_MODE_MEMBER_OFFSET = 2;

function maintainerStreamForIdu(idu) {
    const loc = maintainerDichannelForIdu(idu);
    if (!loc) {
        return "";
    }
    return `${loc.stream}.${loc.member}`;
}

function maintainerDichannelForIdu(idu) {
    const n = Number(idu);
    if (!Number.isFinite(n) || n < 1 || n > 54) {
        return null;
    }
    if (n <= 6) {
        return { stream: "IDU2W", member: n };
    }
    const off = n - 7;
    const floor = Math.floor(off / 8) + 3;
    return { stream: `IDU${floor}W`, member: (off % 8) + 1 };
}

function normalizeRow(row) {
    const idu = parseInt(row && row.idu, 10);
    let flat = row && row.flat;
    if (flat === "" || flat === undefined) {
        flat = null;
    } else if (flat != null) {
        flat = parseInt(flat, 10);
        if (!Number.isFinite(flat)) {
            flat = null;
        }
    }
    let stream = row && row.stream;
    if (stream == null || String(stream).trim() === "") {
        stream = null;
    } else {
        stream = String(stream)
            .trim()
            .replace(/\.\d+$/, "");
    }
    const zone = String((row && row.zone) || "liv").trim();
    const memberBase = parseInt(row && row.memberBase, 10);
    return {
        idu: Number.isFinite(idu) ? idu : 0,
        flat: flat,
        zone: zone,
        stream: stream,
        memberBase: Number.isFinite(memberBase) ? memberBase : 0
    };
}

function normalizeMapRows(mapRows) {
    if (!Array.isArray(mapRows)) {
        return [];
    }
    return mapRows
        .map((row) => normalizeRow(row))
        .filter((row) => row.idu >= 1)
        .sort((a, b) => a.idu - b.idu);
}

function formatMapLabel(entry) {
    if (!entry) {
        return "";
    }
    if (entry.flat == null) {
        return `IDU${String(entry.idu).padStart(3, "0")} ${entry.zone}`;
    }
    return `IDU${String(entry.idu).padStart(3, "0")} flat${entry.flat} ${entry.zone}`;
}

function coolMemberIndex(entry) {
    if (!entry || !entry.stream || entry.memberBase < 1) {
        return null;
    }
    return entry.memberBase + COOL_MODE_MEMBER_OFFSET;
}

function buildMappedSnapshot(mapRows, iduStates) {
    const rows = normalizeMapRows(mapRows);
    return rows.map((entry) => {
        const st = iduStates[entry.idu - 1] || { v: null };
        const coolMember = coolMemberIndex(entry);
        return {
            idu: entry.idu,
            flat: entry.flat,
            zone: entry.zone,
            stream: entry.stream,
            memberBase: entry.memberBase,
            coolMember: coolMember,
            maintainerStream: maintainerStreamForIdu(entry.idu),
            label: formatMapLabel(entry),
            v: st.v
        };
    });
}

module.exports = {
    normalizeMapRows,
    normalizeRow,
    maintainerStreamForIdu,
    maintainerDichannelForIdu,
    formatMapLabel,
    coolMemberIndex,
    buildMappedSnapshot,
    COOL_MODE_MEMBER_OFFSET
};
