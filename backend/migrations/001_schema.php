<?php
// Discussion plugin — initial schema
// Uses hasTable guards so this is safe to run on existing installations.

use Illuminate\Support\Facades\Schema;
use Illuminate\Database\Schema\Blueprint;

if (! Schema::hasTable('participants_rooms')) {
    Schema::create('participants_rooms', function (Blueprint $table) {
        $table->char('id', 36)->primary();
        $table->char('channel_id', 36)->index();
        $table->char('plugin_room_id', 36);
        $table->string('host_member_id')->index();
        $table->string('host_username');
        $table->string('status', 20)->default('open');
        $table->timestamp('created_at')->useCurrent();
        $table->timestamp('updated_at')->nullable();
    });
}

if (! Schema::hasTable('participants_invites')) {
    Schema::create('participants_invites', function (Blueprint $table) {
        $table->char('id', 36)->primary();
        $table->char('room_id', 36)->index();
        $table->char('channel_id', 36)->index();
        $table->string('invited_member_id')->index();
        $table->string('invited_username');
        $table->string('host_member_id');
        $table->string('host_username');
        $table->string('status', 20)->default('pending');
        $table->timestamp('created_at')->useCurrent();
        $table->unique(['room_id', 'invited_member_id']);
    });
}
