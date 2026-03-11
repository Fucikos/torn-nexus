import React, { useState } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

const PRESET_AMOUNTS = [10_000, 50_000, 100_000, 500_000, 1_000_000, 5_000_000];

function fmt(n: number) {
  return "$" + n.toLocaleString();
}

export default function DepositWidget() {
  const [tornName, setTornName] = useState("");
  const [amount, setAmount] = useState<number | "">("");
  const [custom, setCustom] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string; new_balance?: number } | null>(null);
  const [pendingTxs, setPendingTxs] = useState<any[]>([]);
  const [showPending, setShowPending] = useState(false);

  const handleDeposit = async () => {
    if (!tornName.trim() || !amount) return;
    setLoading(true);
    setResult(null);

    const { data, error } = await supabase.functions.invoke("verify-deposit", {
      body: { torn_username: tornName.trim(), amount: Number(amount) },
    });

    setLoading(false);

    if (error) {
      setResult({ success: false, message: error.message || "Something went wrong." });
    } else {
      setResult(data);
    }
  };

  const loadPending = async () => {
    const { data: user } = await supabase
      .from("users")
      .select("id")
      .ilike("username", tornName.trim())
      .single();

    if (!user) return;

    const { data } = await supabase
      .from("transactions")
      .select("*")
      .eq("user_id", user.id)
      .eq("status", "invalid")
      .order("created_at", { ascending: false });

    setPendingTxs(data || []);
    setShowPending(true);
  };

  return (
    <div style={{
      fontFamily: "'Syne', sans-serif",
      background: "#080808",
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    }}>
      <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet" />

      <div style={{ width: "100%", maxWidth: 480 }}>
        {/* Header */}
        <div style={{ marginBottom: 40 }}>
          <div style={{ fontSize: 11, letterSpacing: 4, color: "#444", textTransform: "uppercase", marginBottom: 8 }}>
            Torn Nexus
          </div>
          <h1 style={{ fontSize: 36, fontWeight: 800, color: "#fff", lineHeight: 1.1, margin: 0 }}>
            Deposit<br />
            <span style={{ color: "#f59e0b" }}>Funds</span>
          </h1>
          <p style={{ color: "#444", fontSize: 13, marginTop: 10, fontFamily: "'JetBrains Mono', monospace" }}>
            Send money to Fucikos in-game → verify here → wallet credited instantly
          </p>
        </div>

        {/* Card */}
        <div style={{
          background: "#111",
          border: "1px solid #1f1f1f",
          borderRadius: 16,
          padding: 28,
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}>
          {/* Torn Username */}
          <div>
            <label style={{ fontSize: 11, letterSpacing: 2, color: "#555", textTransform: "uppercase", display: "block", marginBottom: 8 }}>
              Your Torn Username
            </label>
            <input
              value={tornName}
              onChange={e => setTornName(e.target.value)}
              placeholder="e.g. Fluke88"
              style={{
                width: "100%", boxSizing: "border-box", background: "#0d0d0d",
                border: "1px solid #222", borderRadius: 8, padding: "12px 14px",
                color: "#fff", fontSize: 14, fontFamily: "'JetBrains Mono', monospace",
                outline: "none",
              }}
            />
          </div>

          {/* Amount presets */}
          <div>
            <label style={{ fontSize: 11, letterSpacing: 2, color: "#555", textTransform: "uppercase", display: "block", marginBottom: 8 }}>
              Deposit Amount
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 10 }}>
              {PRESET_AMOUNTS.map(p => (
                <button key={p} onClick={() => { setAmount(p); setCustom(false); }} style={{
                  background: amount === p && !custom ? "#f59e0b" : "#0d0d0d",
                  border: `1px solid ${amount === p && !custom ? "#f59e0b" : "#222"}`,
                  color: amount === p && !custom ? "#000" : "#666",
                  borderRadius: 8, padding: "10px 4px", fontSize: 12,
                  fontFamily: "'JetBrains Mono', monospace",
                  cursor: "pointer", fontWeight: amount === p && !custom ? 700 : 400,
                  transition: "all 0.15s",
                }}>
                  {fmt(p)}
                </button>
              ))}
            </div>
            <button onClick={() => { setCustom(true); setAmount(""); }} style={{
              background: custom ? "#1a1a1a" : "transparent",
              border: `1px solid ${custom ? "#333" : "#1a1a1a"}`,
              color: "#555", borderRadius: 8, padding: "8px 16px",
              fontSize: 11, cursor: "pointer", width: "100%",
              fontFamily: "'JetBrains Mono', monospace", letterSpacing: 1,
            }}>
              + Custom amount
            </button>
            {custom && (
              <input
                type="number"
                value={amount}
                onChange={e => setAmount(e.target.value ? Number(e.target.value) : "")}
                placeholder="Enter exact amount..."
                style={{
                  marginTop: 8, width: "100%", boxSizing: "border-box",
                  background: "#0d0d0d", border: "1px solid #f59e0b",
                  borderRadius: 8, padding: "12px 14px", color: "#f59e0b",
                  fontSize: 14, fontFamily: "'JetBrains Mono', monospace", outline: "none",
                }}
              />
            )}
          </div>

          {/* Instructions */}
          {amount && (
            <div style={{ background: "#0d0d0d", border: "1px solid #1a1a1a", borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 11, color: "#555", letterSpacing: 2, marginBottom: 8, textTransform: "uppercase" }}>Instructions</div>
              <div style={{ fontSize: 12, color: "#666", fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.8 }}>
                1. Go to Torn → Send Money<br />
                2. Send <span style={{ color: "#f59e0b" }}>{fmt(Number(amount))}</span> to <span style={{ color: "#fff" }}>Fucikos</span><br />
                3. Come back here and hit Verify
              </div>
            </div>
          )}

          {/* Submit */}
          <button
            onClick={handleDeposit}
            disabled={!tornName.trim() || !amount || loading}
            style={{
              background: tornName.trim() && amount && !loading ? "#f59e0b" : "#1a1a1a",
              color: tornName.trim() && amount && !loading ? "#000" : "#333",
              border: "none", borderRadius: 10, padding: "14px",
              fontSize: 14, fontWeight: 800, cursor: tornName.trim() && amount && !loading ? "pointer" : "not-allowed",
              letterSpacing: 2, textTransform: "uppercase", transition: "all 0.15s",
            }}
          >
            {loading ? "Checking Torn logs..." : "▶ Verify Deposit"}
          </button>

          {/* Result */}
          {result && (
            <div style={{
              background: result.success ? "#0a1a0a" : "#1a0a0a",
              border: `1px solid ${result.success ? "#166534" : "#7f1d1d"}`,
              borderRadius: 10, padding: 16,
            }}>
              <div style={{ fontSize: 13, color: result.success ? "#4ade80" : "#f87171", fontWeight: 600 }}>
                {result.success ? "✓ " : "✗ "}{result.message}
              </div>
              {result.success && result.new_balance && (
                <div style={{ fontSize: 12, color: "#555", marginTop: 6, fontFamily: "'JetBrains Mono', monospace" }}>
                  New balance: <span style={{ color: "#f59e0b" }}>{fmt(result.new_balance)}</span>
                </div>
              )}
              {!result.success && tornName && (
                <button onClick={loadPending} style={{
                  marginTop: 10, background: "transparent", border: "1px solid #333",
                  color: "#555", borderRadius: 6, padding: "6px 12px", fontSize: 11,
                  cursor: "pointer", fontFamily: "'JetBrains Mono', monospace",
                }}>
                  View my pending deposits
                </button>
              )}
            </div>
          )}
        </div>

        {/* Pending table */}
        {showPending && pendingTxs.length > 0 && (
          <div style={{ marginTop: 24, background: "#111", border: "1px solid #1f1f1f", borderRadius: 16, padding: 24 }}>
            <div style={{ fontSize: 11, letterSpacing: 2, color: "#555", textTransform: "uppercase", marginBottom: 16 }}>
              Unverified Deposits
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>
              <thead>
                <tr>
                  {["Amount", "Status", "Date"].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: "6px 10px", color: "#333", fontSize: 10, letterSpacing: 2, borderBottom: "1px solid #1a1a1a" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pendingTxs.map((tx: any) => (
                  <tr key={tx.id}>
                    <td style={{ padding: "8px 10px", color: "#f59e0b" }}>{fmt(tx.amount)}</td>
                    <td style={{ padding: "8px 10px", color: "#f87171" }}>⚠ unverified</td>
                    <td style={{ padding: "8px 10px", color: "#444" }}>{new Date(tx.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ fontSize: 11, color: "#333", marginTop: 12, fontFamily: "'JetBrains Mono', monospace" }}>
              These will be verified once the transfer appears in Torn logs.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
