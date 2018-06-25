// @flow
import { Identity } from "./../index";
import AuthenticationError from "./../security/AuthenticationError";
import { Entity, Policy, Group, api } from "./..";
import type { IAuthentication, IToken } from "./../../types";
import type { Attribute } from "webiny-model";
import _ from "lodash";
import type { $Request } from "express";

class SecurityService implements IAuthentication {
    config: {
        enabled: boolean,
        token: IToken,
        strategies: {
            [name: string]: (req: $Request, identity: Class<Identity>) => Promise<Identity>
        },
        identities: Array<Object>
    };
    defaultPermissions: { api: {}, entities: {} };
    initialized: boolean;
    constructor(config: Object) {
        this.initialized = false;
        this.config = config;
        this.defaultPermissions = { api: {}, entities: {} };
    }

    async init() {
        if (this.initialized) {
            return;
        }

        if (this.config.enabled === false) {
            this.initialized = true;
            return;
        }

        this.setDefaultPermissions(await Policy.getDefaultPoliciesPermissions());

        // Attach event listeners.
        ["create", "update", "delete", "read"].forEach(operation => {
            Entity.on(operation, async ({ entity }) => {
                // If super user enabled, return - no further checks needed.
                if (this.getSuperUser()) {
                    return;
                }

                const request = api.getRequest();
                if (!request) {
                    return;
                }

                const { identity } = request.security;

                const canExecuteOperation = await this.canExecuteOperation(
                    identity,
                    entity,
                    operation
                );

                if (!canExecuteOperation) {
                    throw Error(
                        `Cannot execute "${operation}" operation on entity "${entity.classId}"`
                    );
                }

                if (operation === "create") {
                    if (identity) {
                        entity.owner = identity;
                    }
                }
            });
        });

        this.initialized = true;
    }

    getDefaultPermissions() {
        return this.defaultPermissions;
    }

    setDefaultPermissions(permissions: Object): SecurityService {
        this.defaultPermissions = permissions;
        return this;
    }

    getIdentity(permissions: boolean = false) {
        const request = api.getRequest();
        if (!request) {
            return null;
        }

        return permissions ? request.security.permissions : request.security.identity;
    }

    setIdentity(identity: Identity): SecurityService {
        const request = api.getRequest();
        if (request && request.security) {
            request.security.identity = identity;
        }
        return this;
    }

    identityIsOwner(identity: Identity, entity: Entity) {
        const identityOwner: Attribute = (entity.getAttribute("owner"): any);
        const entityOwner = identityOwner.value.getCurrent();
        return identity.id === _.get(entityOwner, "id", entityOwner);
    }

    identityIsInGroup(identity: Identity, entity: Entity) {
        const identityGroupsAttr: Attribute = (identity.getAttribute("groups"): any);
        const identityGroups: Array<Group> = (identityGroupsAttr.value.getCurrent() || []: any);

        const entityGroupsAttr: Attribute = (entity.getAttribute("groups"): any);
        const entityGroups: Array<Group> = (entityGroupsAttr.value.getCurrent() || []: any);

        for (let i = 0; i < identityGroups.length; i++) {
            let identityGroup = identityGroups[i];
            for (let j = 0; j < entityGroups.length; j++) {
                let entityGroup = entityGroups[j];
                if (identityGroup.id === _.get(entityGroup, "id", entityGroup)) {
                    return true;
                }
            }
        }

        return false;
    }

    async canExecuteOperation(identity: ?Identity, entity: Entity, operation: string) {
        const permissions = this.getIdentity(true);

        // If all enabled (eg. super-admin), return immediately, no need to do further checks.
        const superAdminPermissions = _.get(permissions, "entities.*", []);
        if (superAdminPermissions.includes(true)) {
            return true;
        }

        const entityPermissions = _.get(permissions, `entities.${entity.classId}`);
        if (!entityPermissions) {
            return false;
        }

        // Check if operation is enabled for "other".
        for (let i = 0; i < entityPermissions.length; i++) {
            if (_.get(entityPermissions[i], "other.operations." + operation)) {
                return true;
            }
        }

        if (identity) {
            if (this.identityIsOwner(identity, entity)) {
                for (let i = 0; i < entityPermissions.length; i++) {
                    if (_.get(entityPermissions[i], "owner.operations." + operation)) {
                        return true;
                    }
                }
            }

            if (this.identityIsInGroup(identity, entity)) {
                for (let i = 0; i < entityPermissions.length; i++) {
                    if (_.get(entityPermissions[i], "group.operations." + operation)) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    async sudo(option: () => {}) {
        this.setSuperUser(true);
        const results = await option();
        this.setSuperUser(false);
        return results;
    }

    setSuperUser(flag: boolean): SecurityService {
        _.set(api.getRequest(), "security.superUser", flag);
        return this;
    }

    getSuperUser() {
        return _.get(api.getRequest(), "security.superUser");
    }

    /**
     * Returns Identity class for given `classId`.
     * @param {string} classId
     * @returns {Class<Identity>} Identity class corresponding to given `classId`.
     */
    getIdentityClass(classId: string): Class<Identity> | null {
        for (let i = 0; i < this.config.identities.length; i++) {
            if (this.config.identities[i].identity.classId === classId) {
                return this.config.identities[i].identity;
            }
        }
        return null;
    }

    /**
     * Returns set `Identity` classes.
     * @returns {Array<Class<Identity>>} Set `Identity` classes.
     */
    getIdentityClasses(): Array<Class<Identity>> | null {
        return this.config.identities.map(current => {
            return current.identity;
        });
    }

    /**
     * Create an authentication token for the given user
     * @param identity
     * @param expiresOn
     */
    createToken(identity: Identity, expiresOn: number): Promise<string> {
        return this.config.token.encode(identity, expiresOn);
    }

    /**
     * Verify token and return Identity instance.
     * @param {string} token
     * @return {Promise<null|Identity>} Identity instance.
     */
    async verifyToken(token: string): Promise<?Identity> {
        const decoded = await this.config.token.decode(token.replace("Bearer ", ""));
        let identity = this.getIdentityClass(decoded.data.classId);

        if (!identity) {
            return null;
        }

        const identityId = decoded.data.identityId;
        return ((identity.findById(identityId): any): ?Identity);
    }

    /**
     * Authenticate request.
     * @param data
     * @param identity
     * @param strategy
     * @returns {Identity} A valid system Identity.
     */
    async authenticate(
        data: Object,
        identity: Class<Identity>,
        strategy: string
    ): Promise<Identity> {
        const strategyObject = this.config.strategies[strategy];
        if (!strategyObject) {
            return Promise.reject(
                new AuthenticationError(
                    `Strategy "${strategy}" not found!`,
                    AuthenticationError.UNKNOWN_STRATEGY,
                    { strategy }
                )
            );
        }

        return await strategyObject.authenticate(data, identity);
    }
}

export default SecurityService;
