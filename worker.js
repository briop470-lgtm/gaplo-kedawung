
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Setup-Key"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

async function hashToken(token) {
  const bytes = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function db(env, path, options = {}) {
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        ...options.headers
      }
    }
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Database error ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function getIdentity(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) return null;

  const token_hash = await hashToken(token);
  const rows = await db(
    env,
    `access_tokens?token_hash=eq.${token_hash}&select=id,role,marketing_id,expires_at,revoked_at`
  );

  const identity = rows?.[0];
  if (!identity || identity.revoked_at) return null;

  if (identity.expires_at &&
      new Date(identity.expires_at).getTime() < Date.now()) {
    return null;
  }

  return identity;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
     if (url.pathname === "/api/cek-konfigurasi") {
  return json({
    url_terbaca: Boolean(env.SUPABASE_URL),
    secret_terbaca: Boolean(env.SUPABASE_SERVICE_ROLE_KEY)
  });
}

if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  return json({ error: "Konfigurasi database belum lengkap" }, 500);
}

      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({ status: "online", database_configured: true });
      }

      // TES KONEKSI DATABASE SUPABASE
      if (url.pathname === "/api/tes-database" && request.method === "GET") {
        try {
          const rows = await db(
            env,
            "marketing_users?select=id&limit=1"
          );

          return json({
            success: true,
            database_connected: true,
            table_accessible: true,
            jumlah_data_terbaca: rows.length
          });
        } catch (error) {
          return json({
            success: false,
            database_connected: false,
            error: error.message
          }, 500);
        }
      }

      // Membuat link pribadi. Hanya dapat dilakukan dengan kunci setup admin.
      if (url.pathname === "/api/admin/create-link" &&
          request.method === "POST") {

        if (!env.ADMIN_SETUP_KEY ||
            request.headers.get("X-Admin-Setup-Key") !== env.ADMIN_SETUP_KEY) {
          return json({ error: "Akses administrator ditolak" }, 401);
        }

        const body = await request.json();
        const role = body.role;
        let marketing_id = null;

        if (role === "marketing") {
          const nama = String(body.nama || "").trim().toUpperCase();
          const users = await db(
            env,
            `marketing_users?nama=eq.${encodeURIComponent(nama)}&aktif=eq.true&select=id,nama`
          );
          if (!users?.length) {
            return json({ error: "Nama marketing tidak ditemukan" }, 404);
          }
          marketing_id = users[0].id;
        } else if (role !== "ao") {
          return json({ error: "Role tidak valid" }, 400);
        }

        const token = randomToken();
        const token_hash = await hashToken(token);

        await db(env, "access_tokens", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            token_hash,
            role,
            marketing_id,
            expires_at: new Date(Date.now() + 90 * 86400000).toISOString()
          })
        });

        return json({
          success: true,
          role,
          nama: body.nama || "GAPLO Administrator",
          token,
          message: "Simpan token ini. Token hanya ditampilkan sekali."
        });
      }

      // Semua API di bawah ini wajib memakai link pribadi yang valid.
      if (url.pathname.startsWith("/api/")) {
        const identity = await getIdentity(request, env);
        if (!identity) {
          return json({ error: "Link akses tidak valid atau sudah kedaluwarsa" }, 401);
        }

        if (url.pathname === "/api/me" && request.method === "GET") {
          return json({
            role: identity.role,
            marketing_id: identity.marketing_id
          });
        }

        if (url.pathname === "/api/pengajuan" &&
            request.method === "GET") {

          let path = "pengajuan?select=*&order=created_at.desc";

          if (identity.role === "marketing") {
            path += `&marketing_id=eq.${identity.marketing_id}`;
          }

          const rows = await db(env, path);
          return json({ success: true, data: rows });
        }

        if (url.pathname === "/api/pengajuan" &&
            request.method === "POST") {

          const body = await request.json();

          if (!body.nama || !body.nik || !body.hp) {
            return json({ error: "Nama, NIK, dan nomor HP wajib diisi" }, 400);
          }

          const record = {
            created_by: null,
            marketing_id: identity.role === "marketing"
              ? identity.marketing_id : null,
            nama: String(body.nama).trim(),
            nik: String(body.nik).trim(),
            alamat: body.alamat || null,
            rt: body.rt || null,
            rw: body.rw || null,
            desa: body.desa || null,
            kecamatan: body.kecamatan || null,
            kabupaten: body.kabupaten || null,
            status_perkawinan: body.status_perkawinan || null,
            hp: String(body.hp).trim(),
            plafon: body.plafon || null,
            jangka_waktu: body.jangka_waktu || null,
            keperluan: body.keperluan || null
          };

          const saved = await db(env, "pengajuan", {
            method: "POST",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify(record)
          });

          return json({ success: true, data: saved?.[0] }, 201);
        }

        return json({ error: "Endpoint tidak ditemukan" }, 404);
      }

      // Menampilkan website dari folder public.
      return env.ASSETS.fetch(request);

    } catch (error) {
      return json({ error: "Terjadi kesalahan pada server", detail: error.message }, 500);
    }
  }
};
