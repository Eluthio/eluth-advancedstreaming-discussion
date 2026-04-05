<?php

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class ParticipantsController
{
    private function member(Request $request)
    {
        return $request->attributes->get('member');
    }

    private function room(string $id)
    {
        return DB::table('participants_rooms')->where('id', $id)->first();
    }

    private function notFound()
    {
        return response()->json(['error' => 'Not found'], 404);
    }

    private function forbidden()
    {
        return response()->json(['error' => 'Forbidden'], 403);
    }

    // POST /api/plugins/participants/rooms
    // Body: { channel_id, plugin_room_id }
    public function createRoom(Request $request)
    {
        $member       = $this->member($request);
        $channelId    = $request->input('channel_id');
        $pluginRoomId = $request->input('plugin_room_id');

        if (!$channelId || !$pluginRoomId) {
            return response()->json(['error' => 'channel_id and plugin_room_id required'], 422);
        }

        try {
            // Collect IDs of rooms being closed so we can migrate their pending invites
            $closingIds = DB::table('participants_rooms')
                ->where('channel_id', $channelId)
                ->where('host_member_id', $member->central_user_id)
                ->where('status', 'open')
                ->pluck('id');

            if ($closingIds->isNotEmpty()) {
                DB::table('participants_rooms')
                    ->whereIn('id', $closingIds)
                    ->update(['status' => 'closed', 'updated_at' => now()]);
            }

            $id = (string) Str::uuid();
            DB::table('participants_rooms')->insert([
                'id'             => $id,
                'channel_id'     => $channelId,
                'plugin_room_id' => $pluginRoomId,
                'host_member_id' => $member->central_user_id,
                'host_username'  => $member->username,
                'status'         => 'open',
                'created_at'     => now(),
                'updated_at'     => now(),
            ]);

            // Migrate pending invites from closed rooms → new room so guests
            // who haven't accepted yet still get a valid (live) plugin_room_id
            if ($closingIds->isNotEmpty()) {
                DB::table('participants_invites')
                    ->whereIn('room_id', $closingIds)
                    ->where('status', 'pending')
                    ->update(['room_id' => $id]);
            }
        } catch (\Throwable) {
            return response()->json(['message' => 'Discussion plugin tables are not ready — try disabling and re-enabling the plugin.'], 503);
        }

        return response()->json(['room' => ['id' => $id, 'plugin_room_id' => $pluginRoomId]], 201);
    }

    // DELETE /api/plugins/participants/rooms/{roomId}
    public function closeRoom(Request $request, string $roomId)
    {
        $member = $this->member($request);
        $room   = $this->room($roomId);
        if (!$room) return $this->notFound();
        if ($room->host_member_id !== $member->central_user_id) return $this->forbidden();

        DB::table('participants_rooms')
            ->where('id', $roomId)
            ->update(['status' => 'closed', 'updated_at' => now()]);

        return response()->json(['ok' => true]);
    }

    // POST /api/plugins/participants/rooms/{roomId}/invite
    // Body: { member_id, username }
    public function inviteMember(Request $request, string $roomId)
    {
        $member = $this->member($request);
        $room   = $this->room($roomId);
        if (!$room) return $this->notFound();
        if ($room->host_member_id !== $member->central_user_id) return $this->forbidden();
        if ($room->status !== 'open') return response()->json(['error' => 'Room is closed'], 422);

        $invitedMemberId = $request->input('member_id');
        $invitedUsername = $request->input('username', '');

        if (!$invitedMemberId) {
            return response()->json(['error' => 'member_id required'], 422);
        }

        // Upsert — re-inviting resets a previous decline back to pending
        $existing = DB::table('participants_invites')
            ->where('room_id', $roomId)
            ->where('invited_member_id', $invitedMemberId)
            ->first();

        if ($existing) {
            DB::table('participants_invites')
                ->where('id', $existing->id)
                ->update(['status' => 'pending', 'created_at' => now()]);
        } else {
            DB::table('participants_invites')->insert([
                'id'                => (string) Str::uuid(),
                'room_id'           => $roomId,
                'channel_id'        => $room->channel_id,
                'invited_member_id' => $invitedMemberId,
                'invited_username'  => $invitedUsername,
                'host_member_id'    => $member->central_user_id,
                'host_username'     => $member->username,
                'status'            => 'pending',
                'created_at'        => now(),
            ]);
        }

        return response()->json(['ok' => true], 201);
    }

    // GET /api/plugins/participants/invites/pending
    public function pendingInvites(Request $request)
    {
        $member = $this->member($request);

        try {
            $invites = DB::table('participants_invites')
                ->join('participants_rooms', 'participants_invites.room_id', '=', 'participants_rooms.id')
                ->where('participants_invites.invited_member_id', $member->central_user_id)
                ->where('participants_invites.status', 'pending')
                ->where('participants_rooms.status', 'open')
                ->select(
                    'participants_invites.id',
                    'participants_invites.room_id',
                    'participants_invites.channel_id',
                    'participants_invites.host_member_id',
                    'participants_invites.host_username',
                    'participants_rooms.plugin_room_id'
                )
                ->get();
        } catch (\Throwable) {
            // Tables may not exist yet (migration pending) — return empty safely
            $invites = collect();
        }

        return response()->json(['invites' => $invites]);
    }

    // POST /api/plugins/participants/invites/{inviteId}/accept
    public function acceptInvite(Request $request, string $inviteId)
    {
        $member = $this->member($request);

        $invite = DB::table('participants_invites')
            ->where('id', $inviteId)
            ->where('invited_member_id', $member->central_user_id)
            ->where('status', 'pending')
            ->first();

        if (!$invite) return $this->notFound();

        DB::table('participants_invites')
            ->where('id', $inviteId)
            ->update(['status' => 'accepted']);

        $room = DB::table('participants_rooms')->where('id', $invite->room_id)->first();

        return response()->json([
            'plugin_room_id' => $room?->plugin_room_id,
        ]);
    }

    // POST /api/plugins/participants/invites/{inviteId}/decline
    public function declineInvite(Request $request, string $inviteId)
    {
        $member = $this->member($request);

        DB::table('participants_invites')
            ->where('id', $inviteId)
            ->where('invited_member_id', $member->central_user_id)
            ->update(['status' => 'declined']);

        return response()->json(['ok' => true]);
    }
}
