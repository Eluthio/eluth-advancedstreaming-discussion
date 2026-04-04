<?php
// $pluginPath is provided by the community server plugin loader
// All routes are inside the auth.central middleware group
// and are automatically prefixed with /api/plugins/participants/

use Illuminate\Support\Facades\Route;

require_once $pluginPath . '/controller.php';

Route::prefix('/api/plugins/participants')->middleware(['api', 'auth.central'])->group(function () {
    Route::post('/rooms',                          [ParticipantsController::class, 'createRoom']);
    Route::delete('/rooms/{roomId}',               [ParticipantsController::class, 'closeRoom']);
    Route::post('/rooms/{roomId}/invite',          [ParticipantsController::class, 'inviteMember']);
    Route::get('/invites/pending',                 [ParticipantsController::class, 'pendingInvites']);
    Route::post('/invites/{inviteId}/accept',      [ParticipantsController::class, 'acceptInvite']);
    Route::post('/invites/{inviteId}/decline',     [ParticipantsController::class, 'declineInvite']);
});
