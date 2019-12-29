import {
    absolute,
    debug as _debug,
    getPath,
    setPath,
    jwtDecode,
    makeArray,
    request,
    btoa,
    byCode,
    byCodes,
    units,
    getPatientParam
} from "./lib";

import str from "./strings";
import { fetchConformanceStatement, fetchFhirVersion } from "./smart";
import { SMART_KEY, patientCompartment, fhirVersions } from "./settings";
import HttpError from "./HttpError";
import BaseAdapter from "./adapters/BaseAdapter";
import { Adapter as BrowserAdapter } from "./adapters/BrowserAdapter";

// @ts-ignore
// eslint-disable-next-line no-undef
const { Response } = global.FHIRCLIENT_PURE ? window : require("cross-fetch");
const debug = _debug.extend("client");

/**
 * Adds patient context to requestOptions object to be used with fhirclient.Client.request
 * @param {Object|String} requestOptions Can be a string URL (relative to
 *  the serviceUrl), or an object which will be passed to fetch()
 * @param client Current FHIR client object containing patient context
 * @return {Promise<Object|String>} requestOptions object contextualized to current patient
 */
async function contextualize(requestOptions: string|URL|fhirclient.RequestOptions, client: Client) {

    // This code could be useful for implementing FHIR version awareness in the future:
    //   const fhirVersionsMap = require("./data/fhir-versions");
    //   const fetchFhirVersion = require("./smart").fetchFhirVersion;
    //   const fhirVersion = client.state.fhirVersion || await fetchFhirVersion(client.state.serverUrl) || "";
    //   const fhirRelease = fhirVersionsMap[fhirVersion];

    const base = absolute("/", client.state.serverUrl);

    async function contextualURL(url: URL) {
        const resourceType = url.pathname.split("/").pop();

        if (!resourceType) {
            throw new Error(`Invalid url "${url}"`);
        }

        if (patientCompartment.indexOf(resourceType) == -1) {
            throw new Error(`Cannot filter "${resourceType}" resources by patient`);
        }

        const conformance = await fetchConformanceStatement(client.state.serverUrl);
        const searchParam = getPatientParam(conformance, resourceType);
        url.searchParams.set(searchParam, client.patient.id as string);
        return url.href;
    }

    if (typeof requestOptions == "string" || requestOptions instanceof URL) {
        let url = new URL(requestOptions + "", base);
        return contextualURL(url);
    }

    let url = new URL(requestOptions.url + "", base);
    requestOptions.url = await contextualURL(url);
    return requestOptions;
}

/**
 * Gets single reference by id. Caches the result.
 * @param refId
 * @param cache A map to store the resolved refs
 * @param client The client instance
 * @returns {Promise<Object>} The resolved reference
 * @private
 */
function getRef(
    refId: string,
    cache: fhirclient.JsonObject,
    client: Client
): Promise<fhirclient.JsonObject> {
    let sub = cache[refId];
    if (!sub) {

        // Note that we set cache[refId] immediately! When the promise is
        // settled it will be updated. This is to avoid a ref being fetched
        // twice because some of these requests are executed in parallel.
        cache[refId] = client.request(refId).then(sub => {
            cache[refId] = sub;
            return sub;
        }, (error: Error) => {
            delete cache[refId];
            throw error;
        });
        return cache[refId];
    }
    return sub;
}

/**
 * Resolves a reference in the given resource.
 * @param {Object} obj FHIR Resource
 */
function resolveRef(
    obj: fhirclient.FHIR.Resource,
    path: string,
    graph: boolean,
    cache: fhirclient.JsonObject,
    client: Client
) {
    const node = getPath(obj, path);
    if (node) {
        const isArray = Array.isArray(node);
        return Promise.all(makeArray(node).map((item, i) => {
            const ref = item.reference;
            if (ref) {
                return getRef(ref, cache, client).then(sub => {
                    if (graph) {
                        if (isArray) {
                            setPath(obj, `${path}.${i}`, sub);
                        } else {
                            setPath(obj, path, sub);
                        }
                    }
                }).catch(() => { /* ignore */ });
            }
        }));
    }
}

/**
 * Given a resource and a list of ref paths - resolves them all
 * @param obj FHIR Resource
 * @param {Object} fhirOptions The fhir options of the initiating request call
 * @param cache A map to store fetched refs
 * @param client The client instance
 * @private
 */
function resolveRefs(
    obj: fhirclient.FHIR.Resource,
    fhirOptions: fhirclient.FhirOptions,
    cache: fhirclient.JsonObject,
    client: Client
) {

    // 1. Sanitize paths, remove any invalid ones
    let paths = makeArray(fhirOptions.resolveReferences)
        .filter(Boolean) // No false, 0, null, undefined or ""
        .map(path => String(path).trim())
        .filter(Boolean); // No space-only strings

    // 2. Remove duplicates
    paths = paths.filter((p, i) => {
        let index = paths.indexOf(p, i + 1);
        if (index > -1) {
            debug("Duplicated reference path \"%s\"", p);
            return false;
        }
        return true;
    });

    // 3. Early exit if no valid paths are found
    if (!paths.length) {
        return Promise.resolve();
    }

    // 4. Group the paths by depth so that child refs are looked up
    // after their parents!
    const groups: fhirclient.JsonObject = {};
    paths.forEach(path => {
        const len = path.split(".").length;
        if (!groups[len]) {
            groups[len] = [];
        }
        groups[len].push(path);
    });

    // 5. Execute groups sequentially! Paths within same group are
    // fetched in parallel!
    let task: Promise<any> = Promise.resolve();
    Object.keys(groups).sort().forEach(len => {
        const group = groups[len];
        task = task.then(() => Promise.all(group.map((path: string) => {
            return resolveRef(obj, path, !!fhirOptions.graph, cache, client);
        })));
    });
    return task;
}

export default class Client
{
    public state: fhirclient.ClientState;

    public environment: BaseAdapter;

    public patient: {
        id: string | null
        read: () => Promise<fhirclient.JsonObject>
        request: (requestOptions: string|URL|fhirclient.RequestOptions, fhirOptions?: fhirclient.FhirOptions) => Promise<fhirclient.JsonObject>
        api?: fhirclient.JsonObject
    };

    public encounter: {
        id: string | null
        read: () => Promise<fhirclient.JsonObject>
    };

    public user: {
        id: string | null
        read: () => Promise<fhirclient.JsonObject>
        fhirUser: string | null
        resourceType: string | null
    };

    public api: fhirclient.JsonObject | undefined;

    private _refreshTask: Promise<any> | null = null;

    /**
     * @param {object} environment
     * @param {fhirclient.ClientState|string} state
     */
    constructor(environment: BaseAdapter, state: fhirclient.ClientState)
    {
        /**
         * @type fhirclient.ClientState
         */
        const _state = typeof state == "string" ? { serverUrl: state } : state;

        // Valid serverUrl is required!
        if (!_state.serverUrl || !_state.serverUrl.match(/https?:\/\/.+/)) {
            throw new Error("A \"serverUrl\" option is required and must begin with \"http(s)\"");
        }

        this.state = _state;
        this.environment = environment;

        const client = this;

        // patient api ---------------------------------------------------------
        this.patient = {
            get id() { return client.getPatientId(); },
            read: () => {
                const id = this.patient.id;
                return id ?
                    this.request(`Patient/${id}`) :
                    Promise.reject(new Error("Patient is not available"));
            },
            request: (requestOptions, fhirOptions = {}) => {
                if (this.patient.id) {
                    return (async () => {
                        const options = await contextualize(requestOptions, this);
                        return this.request(options, fhirOptions);
                    })();
                } else {
                    return Promise.reject(new Error("Patient is not available"));
                }
            }
        };

        // encounter api -------------------------------------------------------
        this.encounter = {
            get id() { return client.getEncounterId(); },
            read: () => {
                const id = this.encounter.id;
                return id ?
                    this.request(`Encounter/${id}`) :
                    Promise.reject(new Error("Encounter is not available"));
            }
        };

        // user api ------------------------------------------------------------
        this.user = {
            get fhirUser() { return client.getFhirUser(); },
            get id() { return client.getUserId(); },
            get resourceType() { return client.getUserType(); },
            read: () => {
                const fhirUser = this.user.fhirUser;
                return fhirUser ?
                    this.request(fhirUser) :
                    Promise.reject(new Error("User is not available"));
            }
        };

        // fhir.js api (attached automatically in browser)
        // ---------------------------------------------------------------------
        if ((environment as BrowserAdapter).fhir) {
            this.connect((environment as BrowserAdapter).fhir);
        }
    }

    connect(fhirJs: (options: fhirclient.JsonObject) => fhirclient.JsonObject)
    {
        if (typeof fhirJs == "function") {
            const options: fhirclient.JsonObject = {
                baseUrl: this.state.serverUrl.replace(/\/$/, "")
            };

            const accessToken = getPath(this, "state.tokenResponse.access_token");
            if (accessToken) {
                options.auth = { token: accessToken };
            }
            else {
                const { username, password } = this.state;
                if (username && password) {
                    options.auth = {
                        user: username,
                        pass: password
                    };
                }
            }
            this.api = fhirJs(options);

            const patientId = getPath(this, "state.tokenResponse.patient");
            if (patientId) {
                this.patient.api = fhirJs({
                    ...options,
                    patient: patientId
                });
            }
        }
    }

    /**
     * Returns the ID of the selected patient or null. You should have requested
     * "launch/patient" scope. Otherwise this will return null.
     */
    getPatientId()
    {
        const tokenResponse = this.state.tokenResponse;
        if (tokenResponse) {
            // We have been authorized against this server but we don't know
            // the patient. This should be a scope issue.
            if (!tokenResponse.patient) {
                if (!(this.state.scope || "").match(/\blaunch(\/patient)?\b/)) {
                    debug(str.noScopeForId, "patient", "patient");
                }
                else {
                    // The server should have returned the patient!
                    debug("The ID of the selected patient is not available. Please check if your server supports that.");
                }
                return null;
            }
            return tokenResponse.patient;
        }

        if (this.state.authorizeUri) {
            debug(str.noIfNoAuth, "the ID of the selected patient");
        }
        else {
            debug(str.noFreeContext, "selected patient");
        }
        return null;
    }

    /**
     * Returns the ID of the selected encounter or null. You should have
     * requested "launch/encounter" scope. Otherwise this will return null.
     * Note that not all servers support the "launch/encounter" scope so this
     * will be null if they don't.
     */
    getEncounterId()
    {
        const tokenResponse = this.state.tokenResponse;
        if (tokenResponse) {
            // We have been authorized against this server but we don't know
            // the encounter. This should be a scope issue.
            if (!tokenResponse.encounter) {
                if (!(this.state.scope || "").match(/\blaunch(\/encounter)?\b/)) {
                    debug(str.noScopeForId, "encounter", "encounter");
                }
                else {
                    // The server should have returned the encounter!
                    debug("The ID of the selected encounter is not available. Please check if your server supports that, and that the selected patient has any recorded encounters.");
                }
                return null;
            }
            return tokenResponse.encounter;
        }

        if (this.state.authorizeUri) {
            debug(str.noIfNoAuth, "the ID of the selected encounter");
        }
        else {
            debug(str.noFreeContext, "selected encounter");
        }
        return null;
    }

    /**
     * Returns the (decoded) id_token if any. You need to request "openid" and
     * "profile" scopes if you need to receive an id_token (if you need to know
     * who the logged-in user is).
     */
    getIdToken()
    {
        const tokenResponse = this.state.tokenResponse;
        if (tokenResponse) {
            const idToken = tokenResponse.id_token;
            const scope = this.state.scope || "";

            // We have been authorized against this server but we don't have
            // the id_token. This should be a scope issue.
            if (!idToken) {
                const hasOpenid   = scope.match(/\bopenid\b/);
                const hasProfile  = scope.match(/\bprofile\b/);
                const hasFhirUser = scope.match(/\bfhirUser\b/);
                if (!hasOpenid || !(hasFhirUser || hasProfile)) {
                    debug("You are trying to get the id_token but you are not using the right scopes. Please add 'openid' and 'fhirUser' or 'profile' to the scopes you are requesting.");
                }
                else {
                    // The server should have returned the id_token!
                    debug("The id_token is not available. Please check if your server supports that.");
                }
                return null;
            }
            return jwtDecode(idToken);
        }
        if (this.state.authorizeUri) {
            debug(str.noIfNoAuth, "the id_token");
        }
        else {
            debug(str.noFreeContext, "id_token");
        }
        return null;
    }

    /**
     * Returns the profile of the logged_in user (if any). This is a string
     * having the following shape "{user type}/{user id}". For example:
     * "Practitioner/abc" or "Patient/xyz".
     */
    getFhirUser()
    {
        const idToken = this.getIdToken();
        if (idToken) {
            return idToken.profile;
        }
        return null;
    }

    /**
     * Returns the user ID or null.
     */
    getUserId()
    {
        const profile = this.getFhirUser();
        if (profile) {
            return profile.split("/")[1];
        }
        return null;
    }

    /**
     * Returns the type of the logged-in user or null. The result can be
     * "Practitioner", "Patient" or "RelatedPerson".
     */
    getUserType()
    {
        const profile = this.getFhirUser();
        if (profile) {
            return profile.split("/")[0];
        }
        return null;
    }

    getAuthorizationHeader()
    {
        const accessToken = getPath(this, "state.tokenResponse.access_token");
        if (accessToken) {
            return "Bearer " + accessToken;
        }
        const { username, password } = this.state;
        if (username && password) {
            return "Basic " + btoa(username + ":" + password);
        }
        return null;
    }

    async _clearState() {
        const storage = this.environment.getStorage();
        const key = await storage.get(SMART_KEY);
        if (key) {
            await storage.unset(key);
        }
        await storage.unset(SMART_KEY);
        this.state.tokenResponse = {};
    }

    /**
     * @param resource A FHIR resource to be created
     */
    create(resource: fhirclient.FHIR.Resource)
    {
        return this.request({
            url: `${resource.resourceType}`,
            method: "POST",
            body: JSON.stringify(resource),
            headers:{
                "Content-Type": "application/fhir+json"
            }
        });
    }

    /**
     * @param resource A FHIR resource to be updated
     */
    update(resource: fhirclient.FHIR.Resource)
    {
        return this.request({
            url: `${resource.resourceType}/${resource.id}`,
            method: "PUT",
            body: JSON.stringify(resource),
            headers:{
                "Content-Type": "application/fhir+json"
            }
        });
    }

    /**
     * @param url Relative URI of the FHIR resource to be deleted
     * (format: `resourceType/id`)
     */
    delete(url: string)
    {
        return this.request({
            url,
            method: "DELETE"
        });
    }

    /**
     * @param requestOptions Can be a string URL (relative to the serviceUrl),
     * or an object which will be passed to fetch()
     * @param fhirOptions Additional options to control the behavior
     * @param _resolvedRefs DO NOT USE! Used internally.
     */
    async request(
        requestOptions: string|URL|fhirclient.RequestOptions,
        fhirOptions: fhirclient.FhirOptions = {},
        _resolvedRefs: fhirclient.JsonObject = {}
    )
    {
        const debug = _debug.extend("client:request");
        if (!requestOptions) {
            throw new Error("request requires an url or request options as argument");
        }

        // url -----------------------------------------------------------------
        let url: string;
        if (typeof requestOptions == "string" || requestOptions instanceof URL) {
            url = String(requestOptions);
            requestOptions = {} as fhirclient.RequestOptions;
        }
        else {
            url = String(requestOptions.url);
        }

        url = absolute(url, this.state.serverUrl);

        // authentication ------------------------------------------------------
        const authHeader = this.getAuthorizationHeader();
        if (authHeader) {
            requestOptions.headers = {
                ...requestOptions.headers,
                Authorization: authHeader
            };
        }

        // fhirOptions.graph ---------------------------------------------------
        fhirOptions.graph = (fhirOptions.graph !== false);

        // fhirOptions.flat ----------------------------------------------------
        fhirOptions.flat = !!fhirOptions.flat;

        // fhirOptions.pageLimit -----------------------------------------------
        if (!fhirOptions.pageLimit && fhirOptions.pageLimit !== 0) {
            fhirOptions.pageLimit = 1;
        }

        const hasPageCallback = typeof fhirOptions.onPage == "function";

        debug(
            "%s, options: %O, fhirOptions: %O",
            url,
            requestOptions,
            fhirOptions
        );

        return request(url, requestOptions)

            // Automatic re-auth via refresh token -----------------------------
            .catch((error: HttpError) => {
                debug("%o", error);
                if (error.status == 401 && fhirOptions.useRefreshToken !== false) {
                    const hasRefreshToken = getPath(this, "state.tokenResponse.refresh_token");
                    if (hasRefreshToken) {
                        return (this.refresh() as Promise<any>).then(() => this.request(
                            { ...requestOptions, url },
                            fhirOptions,
                            _resolvedRefs
                        ));
                    }
                }
                throw error;
            })

            // Handle 401 ------------------------------------------------------
            .catch(async (error: HttpError) => {
                if (error.status == 401) {

                    // !accessToken -> not authorized -> No session. Need to launch.
                    if (!getPath(this, "state.tokenResponse.access_token")) {
                        throw new Error("This app cannot be accessed directly. Please launch it as SMART app!");
                    }

                    // !fhirOptions.useRefreshToken -> auto-refresh not enabled
                    // Session expired. Need to re-launch. Clear state to
                    // start over!
                    if (fhirOptions.useRefreshToken === false) {
                        debug("Your session has expired and the useRefreshToken option is set to false. Please re-launch the app.");
                        await this._clearState();
                        throw new Error(str.expired);
                    }

                    // otherwise -> auto-refresh failed. Session expired.
                    // Need to re-launch. Clear state to start over!
                    debug("Auto-refresh failed! Please re-launch the app.");
                    await this._clearState();
                    throw new Error(str.expired);
                }
                throw error;
            })

            // Handle 403 ------------------------------------------------------
            .catch((error: HttpError) => {
                if (error.status == 403) {
                    debug("Permission denied! Please make sure that you have requested the proper scopes.");
                }
                throw error;
            })

            // Handle raw requests (anything other than json) ------------------
            .then(data => {
                if (!data)
                    return data;
                if (typeof data == "string")
                    return data;
                if (typeof data == "object" && data instanceof Response)
                    return data;

                // Resolve References ----------------------------------------------
                return (async (data) => {

                    if (data) {
                        if (data.resourceType == "Bundle") {
                            await Promise.all((data.entry || []).map(item => resolveRefs(
                                item.resource,
                                fhirOptions,
                                _resolvedRefs,
                                this
                            )));
                        }
                        else {
                            await resolveRefs(
                                data,
                                fhirOptions,
                                _resolvedRefs,
                                this
                            );
                        }
                    }

                    return data;
                })(data)

                    // Pagination ------------------------------------------------------
                    .then(async (data) => {
                        if (data && data.resourceType == "Bundle") {
                            const links = data.link || [];

                            if (fhirOptions.flat) {
                                data = (data.entry || []).map(entry => entry.resource);
                            }

                            if (hasPageCallback) {
                                await fhirOptions.onPage(data, { ..._resolvedRefs });
                            }

                            if (--fhirOptions.pageLimit) {
                                const next = links.find(l => l.relation == "next");
                                data = makeArray(data);
                                if (next && next.url) {
                                    const nextPage = await this.request(
                                        next.url,
                                        fhirOptions,
                                        _resolvedRefs
                                    );

                                    if (hasPageCallback) {
                                        return null;
                                    }

                                    if (fhirOptions.resolveReferences && fhirOptions.resolveReferences.length) {
                                        Object.assign(_resolvedRefs, nextPage.references);
                                        return data.concat(makeArray(nextPage.data || nextPage));
                                    }
                                    return data.concat(makeArray(nextPage));
                                }
                            }
                        }
                        return data;
                    })

                    // Finalize --------------------------------------------------------
                    .then(data => {
                        if (fhirOptions.graph) {
                            _resolvedRefs = {};
                        }
                        else if (!hasPageCallback && fhirOptions.resolveReferences.length) {
                            return {
                                data,
                                references: _resolvedRefs
                            };
                        }
                        return data;
                    });
            });
    }

    /**
     * Use the refresh token to obtain new access token. If the refresh token is
     * expired (or this fails for any other reason) it will be deleted from the
     * state, so that we don't enter into loops trying to re-authorize.
     */
    refresh()
    {
        const debug = _debug.extend("client:refresh");
        debug("Attempting to refresh with refresh_token...");

        const refreshToken = this.state?.tokenResponse?.refresh_token;
        if (!refreshToken) {
            throw new Error("Unable to refresh. No refresh_token found.");
        }

        const tokenUri = this.state.tokenUri;
        if (!tokenUri) {
            throw new Error("Unable to refresh. No tokenUri found.");
        }

        const scopes = getPath(this, "state.tokenResponse.scope") || "";
        if (scopes.indexOf("offline_access") == -1 && scopes.indexOf("online_access") == -1) {
            throw new Error("Unable to refresh. No offline_access or online_access scope found.");
        }

        // This method is typically called internally from `request` if certain
        // request fails with 401. However, clients will often run multiple
        // requests in parallel which may result in multiple refresh calls.
        // To avoid that, we keep a to the current refresh task (if any).
        if (!this._refreshTask) {
            this._refreshTask = request(tokenUri, {
                mode   : "cors",
                method : "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded"
                },
                body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
                credentials: "include"
            }).then((data: fhirclient.JsonObject) => {
                if (!data.access_token) {
                    throw new Error("No access token received");
                }
                return data;
            }).then(data => {
                debug("Received new access token %O", data);
                Object.assign(this.state.tokenResponse, data);
                return this.state;
            }).catch((error: Error) => {
                debug("Deleting the expired or invalid refresh token.");
                delete this.state.tokenResponse.refresh_token;
                throw error;
            }).finally(() => {
                this._refreshTask = null;
                this.environment.getStorage().set(this.state.key, this.state);
            });
        }

        return this._refreshTask;
    }

    // utils -------------------------------------------------------------------
    byCode(observations: fhirclient.FHIR.Observation | fhirclient.FHIR.Observation[], property: string) {
        return byCode(observations, property);
    }

    byCodes(observations: fhirclient.FHIR.Observation | fhirclient.FHIR.Observation[], property: string) {
        return byCodes(observations, property);
    }

    get units() {
        return units;
    }

    getPath(object: fhirclient.JsonObject, path: string) {
        return getPath(object, path);
    }

    /**
     * Returns a promise that will be resolved with the fhir version as defined
     * in the conformance statement.
     */
    getFhirVersion(): Promise<string> {
        return fetchFhirVersion(this.state.serverUrl);
    }

    /**
     * Returns a promise that will be resolved with the numeric fhir version
     * - 2 for DSTU2
     * - 3 for STU3
     * - 4 for R4
     * - 0 if the version is not known
     */
    getFhirRelease(): Promise<number> {
        return this.getFhirVersion().then(v => (fhirVersions as fhirclient.JsonObject)[v] ?? 0);
    }
}