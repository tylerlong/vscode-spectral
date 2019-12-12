import { ISourceNodeInstance } from '@stoplight/graphite';
import {
  Activatable,
  ActivatableCollection,
  createDisposable,
  DisposableCollection,
} from '@stoplight/lifecycle';
import { IRuleset } from '@stoplight/spectral/dist/types/ruleset';
import { observable, reaction} from 'mobx';
import { Reporter } from '../../reporter';
import { IMagicPortal } from '../../worker/magic-portal';
import { ISpectralWorker } from '../../worker/spectral/types';
import { GraphStore } from '../graph';
import { NotificationStore } from '../notification';
import { StudioStore } from '../studio';
import { UiStore } from '../ui';

export class SpectralStore extends Activatable {
  private _client: ISpectralWorker;

  private _graphStore: GraphStore;
  private _uiStore: UiStore;
  private _notificationStore: NotificationStore;

  private _activatables = new ActivatableCollection();
  private _activeDisposables = new DisposableCollection();

  @observable.ref
  public currentRuleset: IRuleset | null = null;

  @observable
  public previousRulesetNodeId: string | null = null;

  @observable
  public currentRulesetNode: ISourceNodeInstance | null = null;

  @observable
  public currentRulesetError: string | null = null;

  constructor(private _studioStore: StudioStore, private _portal: IMagicPortal) {
    super();
    this._graphStore = _studioStore.graphStore;
    this._uiStore = _studioStore.uiStore;
    this._notificationStore = _studioStore.notificationStore;

    this._client = this._portal.get<ISpectralWorker>('spectral');
    this._activatables.push(this._client);
  }

  protected async doActivate() {
    this._activeDisposables = new DisposableCollection();

    this._activeDisposables.push(
      createDisposable(
        reaction(
          () => this._uiStore.activeSourceNodeId,
          activeSourceNodeId => {
            if (activeSourceNodeId === void 0) {
              return;
            }

            this._graphStore
              .waitUntilIdle(5000)
              .then(() => {
                if (this._client) {
                  this._client.lint(activeSourceNodeId);
                }
              })
              .catch(e => Reporter.error(e));
          },
          { fireImmediately: true, delay: 500 },
        ),
      ),
    );
  }
}
