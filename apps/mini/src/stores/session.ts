import { defineStore } from 'pinia';
import { get, authPost, currentPending, ApiError } from '../services/api';
import { loadAuth, saveAuth, clearAuth, updateSession, uuid } from '../services/vault';
import type { SessionView, Tokens, Profile, Context, FamilyContext } from '../services/types';
import { go, type RouteName } from '../services/navigation';
let boot: Promise<void> | null = null;
let wired = false;
export const useSession = defineStore('session', {
  state: () => ({
    view: loadAuth()?.session || (null as SessionView | null),
    profile: null as Profile | null,
    contexts: [] as Context[],
    family: null as FamilyContext | null,
    generation: 0,
    loading: false,
    lastValidated: 0,
  }),
  getters: {
    isFamilyReadOnly: (s) => s.family?.family.status === 'ARCHIVED',
    isChild: (s) => s.view?.mode === 'CHILD',
    isGuardian: (s) => s.view?.mode === 'GUARDIAN',
    isOwner: (s) => s.family?.membership.role === 'OWNER',
    isDelegated: (s) => s.view?.childSessionSource === 'DELEGATED',
    canAccount: (s) => s.view?.childSessionSource !== 'DELEGATED',
  },
  actions: {
    async bootstrap() {
      if (!wired) {
        wired = true;
        uni.$on('auth:changed', (view: SessionView | null) => {
          this.view = view;
          this.generation++;
        });
      }
      if (boot) {
        return boot;
      }
      boot = (async () => {
        if (!loadAuth()) {
          this.view = null;
          return;
        }
        this.loading = true;
        try {
          this.view = await get<SessionView>('/auth/session');
          updateSession(this.view);
          this.lastValidated = Date.now();
          if (this.view.mode !== 'LOCKED' && this.view.childSessionSource !== 'DELEGATED') {
            this.profile = await get<Profile>('/me/profile');
          }
          if (this.view.mode === 'GUARDIAN' && this.view.familyId) {
            this.family = await get<FamilyContext>(`/families/${this.view.familyId}`);
          }
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) {
            this.clear();
          } else {
            throw e;
          }
        } finally {
          this.loading = false;
        }
      })().finally(() => {
        boot = null;
      });
      return boot;
    },
    async foreground() {
      if (loadAuth() && Date.now() - this.lastValidated > 30000) {
        try {
          await this.bootstrap();
        } catch {
          /* the visible screen reports and offers retry */
        }
      }
    },
    async login(code?: string) {
      let loginCode = code;
      if (!loginCode) {
        const result = await new Promise<UniApp.LoginRes>((resolve, reject) =>
          uni.login({ provider: 'weixin', success: resolve, fail: reject }),
        );
        loginCode = result.code;
      }
      const data = await authPost<Tokens>('/auth/wechat/login', {
        code: loginCode,
        loginAttemptId: uuid(),
      });
      this.accept(data);
      await this.land();
    },
    accept(tokens: Tokens) {
      saveAuth(tokens);
      this.view = tokens.session;
      this.family = null;
      this.profile = null;
      this.contexts = [];
      this.generation++;
      uni.$emit('scope:changed');
    },
    async loadContexts() {
      const result = await get<{ items: Context[] }>('/me/contexts');
      this.contexts = result.items;
      return this.contexts;
    },
    async selectContext(contextId: string) {
      this.requireSettled();
      const tokens = await authPost<Tokens>('/auth/context', { contextId });
      this.accept(tokens);
      if (tokens.session.mode === 'LOCKED') {
        go('pin', { purpose: 'unlock', contextId }, true);
      } else {
        await this.land();
      }
    },
    async resume() {
      if (!loadAuth()) {
        return false;
      }
      await this.bootstrap();
      if (!this.view) {
        return false;
      }
      this.navigateHome();
      return true;
    },
    async land() {
      await this.bootstrap();
      this.navigateHome();
    },
    navigateHome() {
      if (!this.view) {
        go('login', {}, true);
        return;
      }
      if (this.view.mode === 'LOCKED') {
        go('pin', { purpose: 'unlock' }, true);
        return;
      }
      if (this.view.mode === 'PROFILE_ONLY' || this.view.profileRequired) {
        go('profile', {}, true);
        return;
      }
      if (this.view.mode === 'GUARDIAN') {
        go('home', {}, true);
        return;
      }
      if (this.view.mode === 'CHILD') {
        go('today', {}, true);
        return;
      }
      go('contexts', {}, true);
    },
    async guard(kind: 'public' | 'account' | 'guardian' | 'child' | 'authenticated') {
      if (kind === 'public') {
        return true;
      }
      await this.bootstrap();
      const s = this.view;
      if (!s) {
        go('login', {}, true);
        return false;
      }
      if (kind === 'authenticated') {
        return true;
      }
      if (s.mode === 'LOCKED') {
        go('pin', { purpose: 'unlock' }, true);
        return false;
      }
      if (s.mode === 'PROFILE_ONLY' || s.profileRequired) {
        go('profile', {}, true);
        return false;
      }
      if (kind === 'guardian' && s.mode !== 'GUARDIAN') {
        if (s.childSessionSource === 'DELEGATED') {
          go('pin', { purpose: 'exit' }, true);
        } else {
          go(s.mode === 'CHILD' ? 'today' : 'contexts', {}, true);
        }
        return false;
      }
      if (kind === 'child' && s.mode !== 'CHILD') {
        go(s.mode === 'GUARDIAN' ? 'home' : 'contexts', {}, true);
        return false;
      }
      if (kind === 'account' && s.childSessionSource === 'DELEGATED') {
        go('today', {}, true);
        return false;
      }
      return true;
    },
    requireSettled() {
      if (currentPending().length) {
        go('recovery');
        throw new ApiError('OPERATION_IN_PROGRESS', '先确认此前操作，再切换身份');
      }
    },
    async enterChild(childId: string) {
      this.requireSettled();
      try {
        const tokens = await authPost<Tokens>('/auth/child-mode', {
          familyId: this.view?.familyId,
          childId,
        });
        this.accept(tokens);
        go('today', {}, true);
      } catch (e) {
        if (
          e instanceof ApiError &&
          ['PIN_REQUIRED', 'PIN_NOT_ENABLED', 'PIN_ENROLLMENT_REQUIRED'].includes(e.code)
        ) {
          go('pin', { purpose: 'enroll', childId });
        } else {
          throw e;
        }
      }
    },
    async logout() {
      this.requireSettled();
      await authPost('/auth/logout', {});
      this.clear();
      go('login', {}, true);
    },
    clear() {
      clearAuth();
      this.view = null;
      this.family = null;
      this.profile = null;
      this.contexts = [];
      this.generation++;
      uni.$emit('scope:changed');
    },
    homeRoute(): RouteName {
      return this.view?.mode === 'CHILD'
        ? 'today'
        : this.view?.mode === 'GUARDIAN'
          ? 'home'
          : 'contexts';
    },
  },
});
