import { HttpClient } from '@angular/common/http';
import { Component, NgZone, ViewChild } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { Events, Platform } from 'ionic-angular';

import { AppProvider } from '../../providers/app/app';
import { BwcErrorProvider } from '../../providers/bwc-error/bwc-error';
import { Logger } from '../../providers/logger/logger';
import {
  Network,
  PersistenceProvider
} from '../../providers/persistence/persistence';
import { PlatformProvider } from '../../providers/platform/platform';
import { ProfileProvider } from '../../providers/profile/profile';
import { RateProvider } from '../../providers/rate/rate';
import { TabProvider } from '../../providers/tab/tab';
import { WalletProvider } from '../../providers/wallet/wallet';

import { CardsPage } from '../cards/cards';
import { HomePage } from '../home/home';
import { ScanPage } from '../scan/scan';
import { SettingsPage } from '../settings/settings';
import { WalletsPage } from '../wallets/wallets';

import * as _ from 'lodash';
import { Subscription } from 'rxjs';

@Component({
  templateUrl: 'tabs.html'
})
export class TabsPage {
  appName: string;
  @ViewChild('tabs')
  tabs;
  NETWORK = 'livenet';
  public txpsN: number;
  public cardNotificationBadgeText;
  public scanIconType: string;
  public isCordova: boolean;
  private zone;

  private onResumeSubscription: Subscription;
  private onPauseSubscription: Subscription;

  constructor(
    private plt: Platform,
    private appProvider: AppProvider,
    private profileProvider: ProfileProvider,
    private logger: Logger,
    private walletProvider: WalletProvider,
    private events: Events,
    private persistenceProvider: PersistenceProvider,
    private translate: TranslateService,
    private bwcErrorProvider: BwcErrorProvider,
    private tabProvider: TabProvider,
    private rateProvider: RateProvider,
    private platformProvider: PlatformProvider,
    private http: HttpClient
  ) {
    this.persistenceProvider.getNetwork().then((network: string) => {
      if (network) {
        this.NETWORK = network;
      }
      this.logger.log(`tabs initialized with ${this.NETWORK}`);
    });

    this.zone = new NgZone({ enableLongStackTrace: false });
    this.logger.info('Loaded: TabsPage');
    this.appName = this.appProvider.info.nameCase;
    this.isCordova = this.platformProvider.isCordova;
    this.scanIconType =
      this.appName == 'BitPay' ? 'tab-scan' : 'tab-copay-scan';

    if (this.platformProvider.isElectron) {
      this.updateDesktopOnFocus();
    }

    this.persistenceProvider.getCardExperimentFlag().then(status => {
      if (status === 'enabled') {
        this.persistenceProvider
          .getCardNotificationBadge()
          .then(badgeStatus => {
            this.cardNotificationBadgeText =
              badgeStatus === 'disabled' ? null : 'New';
          });
      }
    });
  }

  private subscribeEvents() {
    this.events.subscribe('experimentUpdateStart', () => {
      this.tabs.select(2);
    });
    this.events.subscribe('bwsEvent', this.bwsEventHandler);
    this.events.subscribe('Local/UpdateTxps', data => {
      this.setTxps(data);
    });
    this.events.subscribe('Local/FetchWallets', () => {
      this.fetchAllWalletsStatus();
    });
  }

  private unsubscribeEvents() {
    this.events.unsubscribe('bwsEvent');
    this.events.unsubscribe('Local/UpdateTxps');
    this.events.unsubscribe('Local/FetchWallets');
    this.events.unsubscribe('experimentUpdateStart');
  }

  async ngOnInit() {
    this.subscribeEvents();
    this.onResumeSubscription = this.plt.resume.subscribe(() => {
      this.subscribeEvents();
      setTimeout(() => {
        this.updateTxps();
        this.fetchAllWalletsStatus();
      }, 1000);
    });

    const cards = await this.persistenceProvider.getBitpayDebitCards(
      this.NETWORK
    );

    if (cards) {
      this.events.publish('CardAdvertisementUpdate', {
        status: 'connected',
        cards
      });
    }

    this.onPauseSubscription = this.plt.pause.subscribe(() => {
      this.events.unsubscribe('bwsEvent');
      this.events.unsubscribe('Local/UpdateTxps');
      this.events.unsubscribe('Local/FetchWallets');
      this.events.unsubscribe('experimentUpdateStart');
    });

    await this.checkCardEnabled();
    await this.tabProvider.prefetchCards();
  }

  ngOnDestroy() {
    this.onResumeSubscription.unsubscribe();
    this.onPauseSubscription.unsubscribe();
    this.unsubscribeEvents();
  }

  private async checkCardEnabled() {
    let cardExperimentEnabled =
      (await this.persistenceProvider.getCardExperimentFlag()) === 'enabled';

    const cards = await this.persistenceProvider.getBitpayDebitCards(
      Network[this.NETWORK]
    );

    if (!cardExperimentEnabled) {
      try {
        this.logger.debug('BitPay: setting country');
        const { country } = await this.http
          .get<{ country: string }>('https://bitpay.com/wallet-card/location')
          .toPromise();
        if (country === 'US') {
          this.logger.debug('If US: Set Card Experiment Flag Enabled');
          await this.persistenceProvider.setCardExperimentFlag('enabled');
          cardExperimentEnabled = true;
        }
      } catch (err) {
        this.logger.error('Error setting country: ', err);
      }
    }

    // set banner advertisement in home.ts
    this.events.publish('CardAdvertisementUpdate', {
      cardExperimentEnabled,
      cards
    });
  }

  disableCardNotificationBadge() {
    this.persistenceProvider.getCardExperimentFlag().then(status => {
      if (status === 'enabled') {
        this.cardNotificationBadgeText = null;
        this.persistenceProvider.setCardNotificationBadge('disabled');
      }
    });
  }

  updateTxps() {
    this.profileProvider.getTxps({ limit: 3 }).then(data => {
      this.setTxps(data);
    });
  }

  setTxps(data) {
    this.zone.run(() => {
      this.txpsN = data.n;
    });
  }

  private updateDesktopOnFocus() {
    const { remote } = (window as any).require('electron');
    const win = remote.getCurrentWindow();
    win.on('focus', () => {
      this.events.publish('Desktop/onFocus');
      setTimeout(() => {
        this.updateTxps();
        this.fetchAllWalletsStatus();
      }, 1000);
    });
  }

  private bwsEventHandler: any = (walletId: string, type: string) => {
    _.each(
      [
        'TxProposalRejectedBy',
        'TxProposalAcceptedBy',
        'transactionProposalRemoved',
        'TxProposalRemoved',
        'NewOutgoingTx',
        'UpdateTx',
        'NewIncomingTx'
      ],
      (eventName: string) => {
        if (
          walletId &&
          type == eventName &&
          (type === 'NewIncomingTx' || type === 'NewOutgoingTx')
        ) {
          this.fetchAllWalletsStatus();
        }
      }
    );
  };

  private updateTotalBalance(wallets) {
    this.rateProvider.getLastDayRates().then(lastDayRatesArray => {
      this.walletProvider
        .getTotalAmount(wallets, lastDayRatesArray)
        .then(data => {
          this.logger.debug('Total Balance and Price Updated');
          this.events.publish('Local/HomeBalance', data);
          this.events.publish('Local/PriceUpdate');
        });
    });
  }

  private processWalletError(wallet, err): void {
    wallet.error = wallet.errorObj = null;

    if (!err || err == 'INPROGRESS') return;

    wallet.cachedStatus = null;
    wallet.errorObj = err;

    if (err.message === '403') {
      this.events.publish('Local/AccessDenied');
      wallet.error = this.translate.instant('Access denied');
    } else if (err === 'WALLET_NOT_REGISTERED') {
      wallet.error = this.translate.instant('Wallet not registered');
    } else {
      wallet.error = this.bwcErrorProvider.msg(err);
    }
    this.logger.warn(
      this.bwcErrorProvider.msg(
        wallet.error,
        'Error updating status for ' + wallet.id
      )
    );
  }

  private connectionError = _.debounce(
    async () => {
      this.events.publish('Local/ConnectionError');
    },
    5000,
    {
      leading: false
    }
  );

  private fetchAllWalletsStatus = _.debounce(
    async () => {
      this._fetchAllWallets();
    },
    5000,
    {
      leading: true
    }
  );

  private _fetchAllWallets() {
    let hasConnectionError: boolean = false;

    this.profileProvider.setLastKnownBalance();

    let wallets = this.profileProvider.wallet;
    if (_.isEmpty(wallets)) {
      this.events.publish('Local/HomeBalance');
      return;
    }

    this.logger.debug('Fetching All Wallets and Updating Total Balance');
    wallets = _.filter(this.profileProvider.wallet, w => {
      return !w.hidden;
    });

    const pr = wallet => {
      return this.walletProvider
        .fetchStatus(wallet, {})
        .then(st => {
          wallet.cachedStatus = st;
          wallet.error = wallet.errorObj = null;
          const balance =
            wallet.coin === 'xrp'
              ? wallet.cachedStatus.availableBalanceStr
              : wallet.cachedStatus.totalBalanceStr;

          this.persistenceProvider.setLastKnownBalance(wallet.id, balance);

          this.events.publish('Local/WalletUpdate', {
            walletId: wallet.id,
            finished: true
          });

          if (!_.isEmpty(st.serverMessages)) {
            this.events.publish('Local/ServerMessages', {
              serverMessages: st.serverMessages
            });
          }

          return Promise.resolve();
        })
        .catch(err => {
          this.processWalletError(wallet, err);
          if (err && err.message == 'Wallet service connection error.') {
            hasConnectionError = true;
            this.connectionError();
          }
          return Promise.resolve();
        });
    };

    const promises = [];

    _.each(wallets, wallet => {
      promises.push(pr(wallet));
    });

    Promise.all(promises).then(() => {
      if (!hasConnectionError) {
        this.updateTotalBalance(wallets);
      }
      this.updateTxps();
    });
  }

  homeRoot = HomePage;
  walletsRoot = WalletsPage;
  scanRoot = ScanPage;
  cardsRoot = CardsPage;
  settingsRoot = SettingsPage;
}
