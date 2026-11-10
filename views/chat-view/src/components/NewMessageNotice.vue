<script setup lang="ts">
    import { inject, type Ref } from 'vue';

    const unreadRecord = inject('unreadRecord') as Ref<string[]>;
    // The producer stores unread IDs in an Array, whose maximum length is 2^32 - 1.
    const unreadCountReservation = String(2 ** 32 - 1);

    defineProps<{
        callback: (messageId:string) => any,
    }>();

    function openFirstUnread(callback: (messageId: string) => any) {
        const id = unreadRecord.value[0];
        if (id) { callback(id); }
    }
</script>

<template>
    <vscode-button :callback="callback" @click="openFirstUnread(callback)" appearance="secondary"
        :style="{ visibility: unreadRecord.length ? 'visible' : 'hidden' }" :inert="!unreadRecord.length" :aria-hidden="!unreadRecord.length">
        <inline>New Messages</inline>
        &nbsp;
        <vscode-badge><span class="unread-count">
            <span class="unread-count-reservation" aria-hidden="true">{{unreadCountReservation}}</span>
            <span>{{unreadRecord.length}}</span>
        </span></vscode-badge>
    </vscode-button>
</template>

<style scoped>
    vscode-badge { font-variant-numeric: tabular-nums; }
    .unread-count { display: inline-grid; }
    .unread-count > span { grid-area: 1 / 1; }
    .unread-count-reservation { visibility: hidden; user-select: none; pointer-events: none; }
    vscode-button {
        border-radius: 4px;
        width: 100%;
        margin-bottom: 4px;
    }
</style>