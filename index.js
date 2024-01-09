const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const request = require("request");

require("dotenv").config();

const { promisify } = require("util");
const exec = promisify(require("child_process").exec);

const storage = require("node-persist");

const app = express();
const PORT = 3001;

app.use(cors());
app.use(bodyParser.json());

async function init() {
    await storage.init({
        dir: "./storage",
    });
    console.log("storage initialized");
}

init();

app.post("/proxy", async (req, res) => {
    const body = req.body;

    const { url, domain, email, apiKey } = body;

    try {
        const data = await exec(`curl --request GET \
        --url 'https://${domain}/rest/api/3/${url}' \
        --user '${email}:${apiKey}' \
        --header 'Accept: application/json'`);

        console.log("url", url, "\n");

        res.json(JSON.parse(data.stdout));
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: error.message ?? error.text() ?? "" });
    }
});

app.get("/spotify/proxy", async (req, res) => {
    const clientEmail = req.query.client_email;
    const clientState = req.query.state;
    const url = req.query.url;
    const method = req.query.method;

    if (!url) {
        res.status(400).json({
            error: "url is required in query params",
        });
        return;
    }

    if (!clientState) {
        res.status(400).json({
            error: "state is required in query params",
        });
        return;
    }

    if (!clientEmail) {
        res.status(400).json({
            error: "client_email is required in query params",
        });
        return;
    }

    // check if the states maches with the one in the storage
    const state = await storage.getItem(clientState);
    const token = await storage.getItem(`${clientEmail}_access_token`);

    if (!token) {
        res.status(500).json({
            error: "token not found",
        });
        return;
    }

    if (state && state !== clientEmail) {
        res.status(400).json({
            error: "state does not match",
        });
        return;
    } else {
        try {
            const response = await fetch(url, {
                method: method ?? "GET",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
            });

            if (method !== "PUT") {
                const data = await response.json();

                res.json(data);
            } else {
                res.status(200);
            }
        } catch (error) {
            console.log(error);
            res.status(500).json({
                error: error.message ?? error.text() ?? "",
            });
        }
    }
});

app.get("/spotify/success", async (req, res) => {
    // return an html page with a success message and instruction to reload the extension tab
    res.send(`
    <html>
        <body>
            <h1>Success!</h1>
            <p>You can now close this tab and reload the extension tab.</p>
        </body>
    </html>
    `);
});

app.get("/spotify/callback", async (req, res) => {
    const code = req.query.code || null;
    const state = req.query.state || null;
    const error = req.query.error || null;

    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    const redirectUri = process.env.SPOTIFY_REDIRECT_URI;

    if (error && state) {
        const clientEmail = await storage.getItem(state);
        await storage.setItem(`${clientEmail}_callback_error`, error);
    }

    if (state === null) {
        console.log("state null");
    } else {
        const clientEmail = await storage.getItem(state);

        var authOptions = {
            url: "https://accounts.spotify.com/api/token",
            form: {
                code: code,
                redirect_uri: redirectUri,
                grant_type: "authorization_code",
            },
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                Authorization:
                    "Basic " +
                    new Buffer.from(`${clientId}:${clientSecret}`).toString(
                        "base64"
                    ),
            },
            json: true,
        };

        request.post(authOptions, async function (error, response, body) {
            if (!error && response.statusCode === 200) {
                var access_token = body.access_token,
                    refresh_token = body.refresh_token;

                await storage.setItem(
                    `${clientEmail}_access_token`,
                    access_token
                );
                await storage.setItem(
                    `${clientEmail}_refresh_token`,
                    refresh_token
                );

                res.redirect(`http://localhost:3001/spotify/success`);
            } else {
                await storage.setItem(`${clientEmail}_callback_error`, error);
            }
        });
    }
});

app.get("/spotify/refresh_token", async function (req, res) {
    const clientEmail = req.query.client_email;
    const refresh_token = await storage.getItem(`${clientEmail}_refresh_token`);

    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    var authOptions = {
        url: "https://accounts.spotify.com/api/token",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            Authorization:
                "Basic " +
                new Buffer.from(`${clientId}:${clientSecret}`).toString(
                    "base64"
                ),
        },
        form: {
            grant_type: "refresh_token",
            refresh_token: refresh_token,
        },
        json: true,
    };

    request.post(authOptions, async function (error, response, body) {
        if (!error && response.statusCode === 200) {
            var access_token = body.access_token,
                refresh_token = body.refresh_token;

            await storage.setItem("access_token", access_token);
            await storage.setItem("refresh_token", refresh_token);
        }
    });
});

app.get("/spotify/auth", async (req, res) => {
    const state = req.query.state;
    const clientEmail = req.query.client_email;

    if (!state) {
        res.status(400).json({
            error: "state is required in query params",
        });
        return;
    }

    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const redirectUri = process.env.SPOTIFY_REDIRECT_URI;
    const scope = "user-read-currently-playing user-modify-playback-state";

    if (!clientEmail) {
        res.status(400).json({
            error: "client_email is required in query params",
        });
    } else {
        await storage.setItem(state, clientEmail);

        res.json({
            redirect: `https://accounts.spotify.com/authorize?response_type=code&client_id=${clientId}&scope=${scope}&redirect_uri=${redirectUri}&state=${state}`,
        });
    }
});

app.listen(PORT, () => {
    console.log(`Backend proxy server running on port ${PORT}`);
});
