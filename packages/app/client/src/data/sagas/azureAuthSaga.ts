import { call, ForkEffect, put, select, takeEvery } from 'redux-saga/effects';
import {
  AZURE_BEGIN_AUTH_WORKFLOW,
  azureArmTokenDataChanged,
  AzureAuthAction,
  AzureAuthWorkflow
} from '../action/azureAuthActions';
import { CommandServiceImpl } from '../../platform/commands/commandServiceImpl';
import { SharedConstants } from '@bfemulator/app-shared';
import { RootState } from '../store';
import { DialogService } from '../../ui/dialogs';
import { AzureAuthState } from '../reducer/azureAuthReducer';

const getArmTokenFromState = (state: RootState) => state.azureAuth;

export function* getArmToken(action: AzureAuthAction<AzureAuthWorkflow>): IterableIterator<any> {
  let azureAuth: AzureAuthState = yield select(getArmTokenFromState);
  if (!azureAuth.armToken.includes('invalid')) {
    return;
  }
  const confirmLoginWithAzure = yield DialogService.showDialog(action.payload.promptDialog);
  if (!confirmLoginWithAzure) {
    return;
  }
  const { RetrieveArmToken, PersistAzureLoginChanged } = SharedConstants.Commands.Azure;
  azureAuth = yield call(CommandServiceImpl.remoteCall.bind(CommandServiceImpl), RetrieveArmToken);
  if (azureAuth) {
    const persistLogin = yield DialogService.showDialog(action.payload.loginSuccessDialog, azureAuth);
    yield call(CommandServiceImpl.remoteCall.bind(CommandServiceImpl), PersistAzureLoginChanged, persistLogin);
  } else {
    yield DialogService.showDialog(action.payload.loginFailedDialog);
  }
  yield put(azureArmTokenDataChanged(azureAuth.armToken));
}

export function* azureAuthSagas(): IterableIterator<ForkEffect> {
  yield takeEvery(AZURE_BEGIN_AUTH_WORKFLOW, getArmToken);
}
