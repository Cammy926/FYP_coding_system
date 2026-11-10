# Local API

Base URL: `http://127.0.0.1:3001/api`. Browser requests go through the frontend's `/api` proxy. Authentication uses an HttpOnly, SameSite=Strict cookie with an eight-hour session. Session IDs are stored as SHA-256 hashes in backend memory, with no MongoDB sessions collection. Logout revokes the in-memory session. Restarting the backend invalidates all logins; saved system data remains in MongoDB.

| Method | Endpoint | Access | Result |
| --- | --- | --- | --- |
| GET | `/health` | Public | Connectivity, database name, collection mapping, and deferred feature flags |
| POST | `/auth/login` | Public | Accepts username/password, sets session cookie |
| POST | `/auth/logout` | Signed in | Revokes session and clears cookie |
| GET | `/auth/me` | Signed in | Account details without password hash |
| GET | `/incident` | Signed in | Active disaster, or null for Super Admin before setup |
| POST | `/incident` | Super Admin | Initializes saved map and generates per-block accounts |
| DELETE | `/incident` | Super Admin | Clears disaster after `confirmation: "CLEAR"` |
| GET | `/incident/accounts` | Admin / Super Admin | Generated account list without hashes |
| GET | `/map` | Admin / Super Admin | Latest map metadata, blocks, annotations (no image bytes) |
| GET | `/map/image` | Admin / Super Admin | Stored PNG |
| GET | `/whatsapp` | Super Admin | Incident-scoped connection status and QR availability |
| POST | `/whatsapp/connect` | Super Admin | Starts/retries the current incident’s sender connection |
| GET | `/whatsapp/qr?incidentId=...` | Super Admin | Current QR PNG; private, no-store |
| GET | `/map/events` | Admin / Super Admin | Authenticated server-sent update events |
| POST | `/map` | Super Admin | Uploads PNG; replacing an image requires its revision |
| PATCH | `/map` | Super Admin | Saves drawings, labels, and draft layouts; initialized-map edits send only on Save |
| GET | `/reports/mine` | Resident | This unit's existing report or null |
| POST | `/reports` | Resident | Immediately saves the chosen status, before optional details |
| PATCH | `/reports/mine/injuries` | Resident | Immediately selects/deselects one injury, or continues to optional details |
| PATCH | `/reports/mine` | Resident | Finalizes optional details for the signed-in unit |
| PATCH | `/floors/:building/:floor` | Admin / Super Admin | Sets cleared/inaccessible/pending search status without changing resident reports |
| GET | `/dashboard` | Admin / Super Admin | Disaster, reports, counts |
| GET | `/items?q=keywords` | Signed in, active disaster | Found items, optionally filtered |
| GET | `/items/:id` | Signed in, active disaster | Found-item details without image bytes |
| GET | `/items/:id/photo` | Signed in, active disaster | Decoded JPEG photo |
| POST | `/items` | Signed in, active disaster | Creates a found-item record |

Upload: `POST /map` with `{ "image": "data:image/png;base64,..." }`; replacing an image requires `revision`. Only still PNG images up to 4 MB and 25 megapixels are accepted. The backend sanitizes, re-encodes, and bounds stored image size.

Save: `PATCH /map` with `{ "revision": 1, "name": "Disaster area", "blocks": [{ "building": 0, "label": "Block A", "floors": 3, "rooms": 2 }], "annotations": [{ "id": "a", "type": "block", "building": 0, "x": 0.5, "y": 0.5 }] }`. Coordinates are normalized to [0,1]. Building markers can also include `w` and `h` as fractions of map width and height (minimum 0.04 and 0.03); both dimensions must be supplied together, and the whole centered label must fit inside the map. Older markers without dimensions keep their automatic size until resized. Building markers also accept optional `fontSize` (8–72 px); omission retains automatic responsive text sizing. Font size is independent of marker w/h and building layouts. Other types: pen (points/color/width), rectangle (x/y/w/h/color/width), text (x/y/text/color/fontSize). Limits: eight blocks, 1–40 floors and 1–20 units per floor for each block, 200 drawings, bounded point counts and document size. Notes render as plain text.

Initialize: `POST /incident` with `{ "mapRevision": 2 }`. Each block needs a clickable label. Before initialization, only Super Admin can authenticate. Accounts are generated per block. Existing pre-map incidents are linked without recreating accounts or reports. Active floor/unit layouts and account prefixes remain locked; label descriptions, positions, and drawings remain editable. Successful edits increment the revision and publish a map event; stale revisions return 409.

Blocks returned by the API include accountPrefix. Prefixes follow labels (Block D → D), independent of building index. Custom labels require an explicit unique A–Z accountPrefix. New single-block setups also use prefixed accounts. Duplicate prefixes return 400; changing an initialized prefix or block letter returns 409.

`GET /dashboard?building=0` returns counts and reports for that map block only; index 0 can refer to Block D. Omitting the query returns aggregate counts. Invalid indexes return 400. Clear Setup also removes the map and blocks Admin/resident login until the next initialization.

Button press: `POST /reports` with `{ "status": "safe" }` or `{ "status": "help" }`. This immediately saves one report for the signed-in unit with blank optional fields and `detailsSubmittedAt: null`. A first save returns 201, an identical status retry returns 200 without creating another report, and choosing the other status afterward returns 409. Unit identity always comes from the authenticated account.

Optional details: `PATCH /reports/mine`. For Safe, send `{ "familyPhone": "+85291234567" }` or `{}`. For Help, send `{ "situation": "Two people need assistance", "location": "Building A stairwell", "contact": "+85291234567" }` or `{}`. Every field is optional; empty or whitespace-only values save as blank. Supplied phone numbers allow 8–15 digits and optional country-code `+`, ignoring spaces, parentheses, and hyphens. The button's status and original reporting time stay unchanged. Submission sets `detailsSubmittedAt`; matching retries return 200, while later edits or status changes are rejected. Existing reports from the previous version remain completed.

The dashboard counts every saved button press, even without a details submission. The admin interface displays `N/A` for blank situation, location, contact, and family contact. The browser resumes the unfinished injury selection or optional details after reload or a new login. WhatsApp family notifications are available when enabled and linked.

Found item: `{ "photo": "data:image/jpeg;base64,...", "description": "Mickey Mouse toy", "place": "Building A lobby", "category": "Toys", "contact": "finder@example.com" }`. Categories: Toys, Documents, Electronics, Clothing, Other. Finder contact can be a phone or email. Photos must decode as a JPEG, PNG, or WebP, up to 2 MB of input bytes and 25 megapixels. The backend re-encodes a JPEG at up to 1200 × 1200, removes metadata, and stores it inside MongoDB. The frontend first resizes selected photos up to 10 MB.

Keyword searching requires every input word to appear in the combined description, place, or category, ignoring case. It treats punctuation literally and does not use Atlas Search, regex supplied by the client, or AI.

Errors use `{ "error": "Readable explanation" }` with 400 for invalid input, 401 for invalid/expired sessions, 403 for forbidden actions, 404 for missing items/routes, 409 for an existing setup/report or no active disaster, 413 for oversized JSON, 429 for rate limiting, and 503 for unavailable database/services. Error messages never include the database URI. A successful write response is sent only after MongoDB confirms the save.

## Floor searches

`PATCH /floors/0/1` accepts `{ "incidentId": "current-disaster-uuid", "status": "cleared", "note": "", "revision": 0 }`. Building indexes are zero-based; floors are one-based. Status is cleared, inaccessible, or not_started. Notes are optional except that inaccessible requires a nonblank reason, at most 300 characters. The floor must exist in the active initialized map. The incidentId must match the active incident, so a stale page cannot update a new disaster. The server generates record identity from the active incident and validated route; account identity is always authenticated.

Revision 0 means no previous record; each change increments revision. Matching repeats are idempotent. A stale conflicting update returns 409. Only Admin and Super Admin can update status; sessions and active incident are rechecked inside the write queue. Changes publish a floor-search event on the existing authenticated /map/events stream.

Dashboard results include floorSearches and searchProgress: `{ "cleared": 1, "inaccessible": 1, "pending": 3, "total": 5 }`. The building query filters floor progress as well as reports; omitted building means all blocks. Inaccessible floors are not counted as cleared. Safe/help/no-response counts remain independent of floor searches.

## Injury selections

After Help is saved, residents see four multi-select illustrated buttons with English descriptions and Traditional Chinese labels. IDs are `bleeding` (wounds/bleeding), `fracture` (fractures/dislocations), `burns` (burns/scalds), and `smoke_inhalation`.

`PATCH /reports/mine/injuries` accepts `{ "injury": "bleeding", "selected": true }` or `selected: false`. Each tap immediately updates MongoDB with add-to-set/pull semantics, increments the report revision, and publishes a `reports` event to manager windows. Explicit selection states make repeats idempotent and separate taps cannot overwrite the other selections. Identity comes from the signed-in account; managers cannot edit a resident's injuries. Safe reports, reports not yet created, and finalized reports cannot be edited through this endpoint. Invalid injury IDs/states return 400.

Send `{ "completeStep": true }` on the same endpoint to persist the Continue step. Zero selections are allowed. This sets injuryStepCompletedAt while leaving detailsSubmittedAt null; optional typing and final Submit remain separate. The browser uses keepalive requests for injury taps and the initial Safe/Help button. Every success is shown after the database acknowledges it. Selection failure leaves the resident on the same page with an error.

Dashboard responses include injuryCounts, e.g. `{ "bleeding": 2, "fracture": 1, "burns": 0, "smoke_inhalation": 1 }`. Counts include only Help reports, respect the selected building, and count each unit once per type, including reports whose details are unfinished. A unit may be counted in several types. Missing injury arrays in older reports mean no selected categories. The same icons appear in unit cells, urgent requests, and report details. Polling remains a fallback for missed live events; report revisions and refresh ordering prevent stale responses from undoing saved selections.

## WhatsApp notification integration

GET /health includes features.whatsapp (configuration enabled, not proof of connection) and whatsapp: {enabled, state}. States include disabled, starting, qr_required, authenticated, ready, disconnected, auth_failure, error, and stopped. It never exposes the sender number, QR payload, or auth session. QR linking takes place on the authenticated Super Admin initialization page. No sender starts before a map is initialized; completed active setups reconnect after backend restarts.

The existing PATCH /reports/mine queues a notification only on the first successful finalization of a Safe report with a nonblank familyPhone while WhatsApp is enabled. A bare eight-digit local number defaults to +852; other numbers should include their international country code. Identical retries return the saved report without requeueing. Help submissions are not_applicable; blank Safe numbers are skipped. Disabled deployments retain disabled status. Earlier completed reports are not backfilled or resent. Status changes and existing details locks remain unchanged.

notificationStatus values: not_requested (Safe button saved, awaiting optional phone form), pending, sending, sent, failed, unknown, skipped, not_applicable, disabled. The background processor checks the current active, initialized incident and atomically claims pending reports. Network calls run outside the incident mutation queue so resident safety reporting remains responsive. Completion updates increment report revision and publish reports events for responders; resident polling also updates confirmation state.

An unregistered recipient fails immediately. Recipient lookup connection problems retry at most three times with increasing backoff. Once sending begins, an error or timeout is treated as unknown, and is never automatically retried. On backend restart, interrupted sending jobs become unknown while queued jobs remain pending. Sent is an acknowledgement of the send call, not proof of recipient delivery/read. Clear Setup pauses new jobs, drains the in-flight worker, and confirms WhatsApp logout before deleting incident data; queued jobs are deleted with the reports. Already-submitted messages cannot be recalled.

## Final WhatsApp initialization step

POST /incident, when messaging is enabled, returns an active provisioned incident with setupComplete=false and an incident-specific whatsappClientId. This stage is recoverable across backend restarts and is not treated as interrupted account provisioning. Only Super Admin may sign in until setupComplete becomes true. Disabled messaging deployments skip this step explicitly.

POST /whatsapp/connect requires {incidentId: "current-disaster-uuid"}; old IDs return 409. A stalled authenticated/error attempt restarts while retaining its saved login. GET /whatsapp returns state, qrAvailable, qrVersion, incidentId, setupComplete, and an optional problem code (connection_timeout or initialization_failed). Startup/post-authentication connection attempts time out after 90 seconds; waiting for a QR scan has no timeout. GET /whatsapp/qr requires the current incidentId and returns a no-store PNG only for Super Admin and the bound sender; unauthenticated requests return 401, other roles 403, stale disaster IDs 409, and absent/consumed QR codes 404. QR data is never included in public health responses.

Phone-side logout reports disconnected with problem logged_out until a fresh QR is available. Reconnect never resets setupComplete or deletes incident data. Completed incidents continue to allow resident login/reporting and manager dashboard access while the sender is disconnected. Sender recovery closes only a verified browser for the exact managed LocalAuth profile, under the transport lock.

A ready event completes setup only when the transport binding matches the current incident’s sender identity. The server persists setupComplete, setupCompletedAt, and whatsappLinkedAt, then publishes setup. The browser transitions automatically to the disaster map. Authenticated/QR events alone cannot complete setup. Subsequent disconnects leave the completed setup usable for safety reporting.

Clear calls remote logout before marking the incident clearing and removing its records. Logout failure returns 503 with data preserved for retry. A successful clear removes the sender’s profile, so future setup cannot reuse its session. Ordinary shutdown uses destroy, retaining the login; clear uses logout. Existing completed deployments without setupComplete retain their previous access and sender until cleared.
