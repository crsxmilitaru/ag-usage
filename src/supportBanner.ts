import { SUPPORT_BANNER_MIN_PANEL_OPENS } from './constants';

interface SupportBannerSnapshot {
	panelOpens: number;
	dismissed: boolean;
}

export class SupportBannerState {
	private panelOpens: number;
	private dismissed: boolean;

	constructor(saved: unknown, private readonly persist: (snapshot: SupportBannerSnapshot) => void) {
		const stored = saved && typeof saved === 'object' ? saved as Partial<SupportBannerSnapshot> : {};
		this.panelOpens = typeof stored.panelOpens === 'number' && Number.isFinite(stored.panelOpens)
			? Math.min(Math.max(Math.floor(stored.panelOpens), 0), SUPPORT_BANNER_MIN_PANEL_OPENS)
			: 0;
		this.dismissed = stored.dismissed === true;
	}

	public get isVisible(): boolean {
		return !this.dismissed && this.panelOpens >= SUPPORT_BANNER_MIN_PANEL_OPENS;
	}

	public recordPanelOpen(): void {
		if (this.dismissed || this.panelOpens >= SUPPORT_BANNER_MIN_PANEL_OPENS) {
			return;
		}
		this.panelOpens++;
		this.persist(this.snapshot());
	}

	public dismiss(): void {
		if (this.dismissed) {
			return;
		}
		this.dismissed = true;
		this.persist(this.snapshot());
	}

	private snapshot(): SupportBannerSnapshot {
		return { panelOpens: this.panelOpens, dismissed: this.dismissed };
	}
}
