const express = require('express');
const cors = require('cors');
const path = require('path');
const { Redis } = require('@upstash/redis');

const app = express();
const PORT = process.env.PORT || 3002;

// Inisialisasi Upstash Redis (Otomatis membaca UPSTASH_REDIS_REST_URL & UPSTASH_REDIS_REST_TOKEN dari Env)
const redis = Redis.fromEnv();

app.use(cors());
app.use(express.static(__dirname));

/**
 * HELPER CACHING UNIVERSAL
 * @param {string} cacheKey - Key unik di Redis (misal: 'cache:kgi')
 * @param {Function} fetcherFn - Fungsi async untuk mengambil data segar jika Cache MISS
 * @param {number} ttlSeconds - Durasi simpan cache dalam detik (default: 60 detik)
 */
async function getCachedOrFetch(cacheKey, fetcherFn, ttlSeconds = 60) {
    try {
        // 1. Cek apakah data ada di Redis Cache
        const cachedData = await redis.get(cacheKey);
        if (cachedData) {
            console.log(`⚡ [REDIS CACHE HIT] Mengembalikan data dari cache key: ${cacheKey}`);
            return typeof cachedData === 'string' ? JSON.parse(cachedData) : cachedData;
        }
    } catch (err) {
        console.error(`⚠️ Redis read error (${cacheKey}), bypass cache:`, err.message);
    }

    // 2. Jika Cache MISS -> Tarik data dari API Sekuritas
    console.log(`🐢 [CACHE MISS] Tarik data segar dari API sekuritas untuk key: ${cacheKey}...`);
    const freshData = await fetcherFn();

    // 3. Simpan data baru ke Redis jika data berhasil ditarik
    if (freshData && freshData.length > 0) {
        try {
            await redis.set(cacheKey, JSON.stringify(freshData), { ex: ttlSeconds });
            console.log(`💾 [REDIS SAVED] Data berhasil disimpan ke cache key: ${cacheKey} (TTL: ${ttlSeconds}s)`);
        } catch (err) {
            console.error(`⚠️ Redis write error (${cacheKey}):`, err.message);
        }
    }

    return freshData;
}

// 1. ENDPOINT KGI (HD)
app.get('/api/kgi', async (req, res) => {
    try {
        const dataArray = await getCachedOrFetch('cache:warrant:kgi', async () => {
            const response = await fetch("https://warrants.kgi.id/StructuredWarrant/WarrantSearch/Searchs/SearchData", {
                "headers": {
                    "accept": "application/json, text/plain, */*",
                    "accept-language": "en-US,en;q=0.9",
                    "authorization": "Bearer eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI3NzcxMjEyNS01NzA5LTRkNTAtYWNhMC04MWE2Y2NjZDFiMjIiLCJMb2dpblVzZXJJZCI6IlN0cnVjdHVyZWRXYXJyYW50IiwiTG9naW5Vc2VyTmFtZSI6IkluZG9uZXNpYSIsIkxvZ2luVXNlckVtYWlsIjoiaXQuYXBAa2dpLmNvbSIsIm5iZiI6MTc4OTQzMTY4MCwiZXhwIjoxNzg5NTE4MDgwLCJpYXQiOjE3ODk0MzE2ODAsImlzcyI6Imh0dHBzOi8va2dpLmNvbSIsImF1ZCI6Imh0dHBzOi8va2dpLmNvbSJ9.itx5_wfrqaQQjwUQX3itSPJoXoXtAJ428FAeltZMGjd9Mxl8yrloG0dj_9C0K_UxH7JzpldsMOHEyjeNah6K5g",
                    "content-type": "application/json",
                    "Referer": "https://warrants.kgi.id/id/warrant-search"
                },
                "body": "{\"Underlying\":\"All\",\"IssuingBroker\":\"PT KGI SEKURITAS INDONESIA\",\"Callput\":-1,\"EffectiveGearing1\":-1,\"EffectiveGearing2\":-1,\"ExercisePrice1\":\"All\",\"ExercisePrice2\":\"All\",\"TimeMaturity1\":-1,\"TimeMaturity2\":-1,\"Moneyness1\":-1,\"Moneyness2\":-1,\"WarrantPrice1\":\"0\",\"WarrantPrice2\":\"50\",\"Page\":1,\"ItemsPerPage\":-1,\"SortName\":\"\",\"SortDirection\":\"\"}",
                "method": "POST"
            });
            const rawText = await response.text();
            const jsonData = JSON.parse(rawText);
            
            let list = [];
            if (jsonData && jsonData.Value && Array.isArray(jsonData.Value.Warrants)) list = jsonData.Value.Warrants;
            else if (jsonData && Array.isArray(jsonData.data)) list = jsonData.data;
            else if (Array.isArray(jsonData)) list = jsonData;
            return list;
        }, 60); // Cache selama 60 detik

        res.json({ stats: { success: ['KGI'], failed: [] }, data: dataArray });
    } catch (error) {
        console.error("❌ Error KGI:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// 2. ENDPOINT MAYBANK (ZP)
app.get('/api/maybank', async (req, res) => {
    try {
        const dataArray = await getCachedOrFetch('cache:warrant:maybank', async () => {
            const response = await fetch("https://waran.maybank.com/mibbwebservice/GetScreenerData", {
                "headers": {
                    "accept": "application/json, text/javascript, */*; q=0.01",
                    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "Referer": "https://waran.maybank.com/id/WarrantTools/WarrantSearch"
                },
                "body": "token=webkey&underlying=all&type=all&issuer=MSI&maturity=all&moneyness=all&effectiveGearing=all&expiry=all&sensitivity=all&indicator=all&sortBy=wcode&sortOrder=asc",
                "method": "POST"
            });
            const rawText = await response.text();
            const jsonData = JSON.parse(rawText);
            return Array.isArray(jsonData) ? jsonData : (jsonData.data || []);
        }, 60);

        res.json({ stats: { success: ['Maybank'], failed: [] }, data: dataArray });
    } catch (error) {
        console.error("❌ Error Maybank:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// 3. ENDPOINT RHB (DR)
app.get('/api/rhb', async (req, res) => {
    try {
        const dataArray = await getCachedOrFetch('cache:warrant:rhb', async () => {
            const response = await fetch("https://waran.rhbtradesmart.co.id/rhbwebservice/GetScreenerData", {
                "headers": {
                    "accept": "application/json, text/javascript, */*; q=0.01",
                    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "Referer": "https://waran.rhbtradesmart.co.id/id/WarrantSearch"
                },
                "body": "token=webkey&underlying=all&type=all&issuer=RHB&maturity=all&moneyness=all&effectiveGearing=all&expiry=all&sortBy=wcode&sortOrder=asc",
                "method": "POST"
            });
            const rawText = await response.text();
            const jsonData = JSON.parse(rawText);
            
            if (jsonData && Array.isArray(jsonData.ric)) return jsonData.ric;
            if (Array.isArray(jsonData)) return jsonData;
            return jsonData.data || jsonData.d || [];
        }, 60);

        res.json({ stats: { success: ['RHB'], failed: [] }, data: dataArray });
    } catch (error) {
        console.error("❌ Error RHB:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// 4. ENDPOINT CGSI (YU)
app.get('/api/cgsi', async (req, res) => {
    try {
        const dataArray = await getCachedOrFetch('cache:warrant:cgsi', async () => {
            const response = await fetch("https://waran.cgsi.co.id/cgsi/api/v1/GetScreenerData?token=webkey&underlying=all&type=all&moneyness=all&maturity=all&effectiveGearing=all&issuer=CGS&expiry=all&indicator=all&sensitivity=all&sortBy=wcode&sortOrder=asc", {
                "headers": {
                    "accept": "application/json, text/javascript, */*; q=0.01",
                    "Referer": "https://waran.cgsi.co.id/WarrantTools/WarrantSearch"
                },
                "method": "GET"
            });
            const rawText = await response.text();
            const jsonData = JSON.parse(rawText);
            return Array.isArray(jsonData.data) ? jsonData.data : (jsonData.ric || []);
        }, 60);

        res.json({ stats: { success: ['CGSI'], failed: [] }, data: dataArray });
    } catch (error) {
        console.error("❌ Error CGSI:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// 5. ENDPOINT KISI (BQ)
app.get('/api/kisi', async (req, res) => {
    try {
        const dataArray = await getCachedOrFetch('cache:warrant:kisi', async () => {
            const response = await fetch("https://api-compro.kisi.co.id/api/v2/swari/product/1", {
                "headers": {
                    "accept": "*/*",
                    "Referer": "https://www.kisi.co.id/"
                },
                "method": "GET"
            });
            const rawText = await response.text();
            const jsonData = JSON.parse(rawText);
            return Array.isArray(jsonData) ? jsonData : (jsonData.data || []);
        }, 60);

        res.json({ stats: { success: ['KISI'], failed: [] }, data: dataArray });
    } catch (error) {
        console.error("❌ Error KISI:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Master Proxy Server dengan Redis Caching Berjalan di port ${PORT}`);
});

module.exports = app;