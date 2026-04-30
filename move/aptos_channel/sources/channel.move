/// Payment channel module for the Aptos Machine Payments Protocol (MPP).
///
/// Flow:
///   1. deployer calls initialize() once after publishing
///   2. client calls open_channel() — deposits to escrow, channel_id emitted via ChannelOpened
///   3. per request: client signs a voucher off-chain with monotonically increasing cumulative total
///   4. server calls close_channel() with the highest accepted voucher to settle and close
///   5. if channel expires unresolved, anyone calls expire_channel() to return balance to client
module aptos_mpp::channel {
    // Only import what is actually used. Each alias must be referenced in code.
    use std::signer;
    use std::vector;
    use aptos_std::table::{Self, Table};
    use aptos_framework::account::{Self, SignerCapability};
    use aptos_framework::object::{Self, Object};
    use aptos_framework::fungible_asset::Metadata;
    use aptos_framework::primary_fungible_store;
    use aptos_framework::timestamp;
    use aptos_framework::event;
    use aptos_framework::ed25519;

    // ── Error codes ──────────────────────────────────────────────────────

    const EALREADY_INITIALIZED:  u64 = 1;
    const ECHANNEL_NOT_FOUND:    u64 = 2;
    const ECHANNEL_EXPIRED:      u64 = 3;
    const ECHANNEL_NOT_EXPIRED:  u64 = 4;
    const EINVALID_AMOUNT:       u64 = 5;
    const ENOT_AUTHORIZED:       u64 = 6;
    const EINVALID_SIGNATURE:    u64 = 7;
    const ESTALE_VOUCHER:        u64 = 8;
    const EINSUFFICIENT_BALANCE: u64 = 9;
    const EWRONG_ASSET:          u64 = 10;

    // ── Structs ──────────────────────────────────────────────────────────

    struct Channel has store, drop {
        id:                 u64,
        client:             address,
        client_public_key:  vector<u8>,
        recipient:          address,
        asset_metadata:     address,
        balance:            u64,
        cumulative_settled: u64,
        expiry_timestamp:   u64,
        is_open:            bool,
    }

    // ChannelRegistry is stored at the deployer's address.
    // It does NOT need UID — that is Sui. Aptos uses 'key' ability with borrow_global.
    struct ChannelRegistry has key {
        channels:    Table<u64, Channel>,
        next_id:     u64,
        signer_cap:  SignerCapability,
        escrow_addr: address,
    }

    // ── Events ───────────────────────────────────────────────────────────
    // #[event] is a valid Aptos attribute — tells the indexer to emit these as events.
    // Do NOT wrap in #[ext(...)]; that is Sui syntax.

    #[event]
    struct ChannelOpened has drop, store {
        channel_id:     u64,
        client:         address,
        recipient:      address,
        asset_metadata: address,
        deposit_amount: u64,
        expiry:         u64,
    }

    #[event]
    struct ChannelToppedUp has drop, store {
        channel_id:  u64,
        additional:  u64,
        new_balance: u64,
    }

    #[event]
    struct ChannelClosed has drop, store {
        channel_id:      u64,
        settled_amount:  u64,
        refunded_amount: u64,
    }

    #[event]
    struct ChannelExpired has drop, store {
        channel_id:      u64,
        refunded_amount: u64,
    }

    // ── Initialisation ───────────────────────────────────────────────────

    public entry fun initialize(deployer: &signer){
        let deployer_addr = signer::address_of(deployer);
        // Abort if already initialised
        assert!(
            !exists<ChannelRegistry>(deployer_addr),
            EALREADY_INITIALIZED
        );
        let (escrow_signer, signer_cap) =
            account::create_resource_account(deployer, b"aptos_mpp_channel_v1");
        let escrow_addr = signer::address_of(&escrow_signer);
        move_to(deployer, ChannelRegistry {
            channels:    table::new(),
            next_id:     0,
            signer_cap,
            escrow_addr,
        });
        // Suppress unused variable warning on escrow_signer — we only needed its address.
        let _ = escrow_addr;
    }

    // ── Open channel ─────────────────────────────────────────────────────

    public entry fun open_channel(
        sender:            &signer,
        recipient:         address,
        asset_metadata:    Object<Metadata>,
        deposit_amount:    u64,
        expiry_timestamp:  u64,
        client_public_key: vector<u8>,
    ) acquires ChannelRegistry {
        assert!(deposit_amount > 0, EINVALID_AMOUNT);

        let sender_addr = signer::address_of(sender);
        let meta_addr   = object::object_address(&asset_metadata);
        let registry    = borrow_global_mut<ChannelRegistry>(@aptos_mpp);
        let escrow_addr = registry.escrow_addr;
        let channel_id  = registry.next_id;
        registry.next_id = registry.next_id + 1;

        primary_fungible_store::transfer(sender, asset_metadata, escrow_addr, deposit_amount);

        table::add(&mut registry.channels, channel_id, Channel {
            id:                 channel_id,
            client:             sender_addr,
            client_public_key,
            recipient,
            asset_metadata:     meta_addr,
            balance:            deposit_amount,
            cumulative_settled: 0,
            expiry_timestamp,
            is_open:            true,
        });

        event::emit(ChannelOpened {
            channel_id,
            client:         sender_addr,
            recipient,
            asset_metadata: meta_addr,
            deposit_amount:        deposit_amount,
            expiry:         expiry_timestamp,
        });
    }

    // ── Top up ───────────────────────────────────────────────────────────

    public entry fun topup_channel(
        sender:            &signer,
        channel_id:        u64,
        asset_metadata:    Object<Metadata>,
        additional_amount: u64,
    ) acquires ChannelRegistry {
        assert!(additional_amount > 0, EINVALID_AMOUNT);

        let sender_addr = signer::address_of(sender);
        let meta_addr   = object::object_address(&asset_metadata);
        let registry    = borrow_global_mut<ChannelRegistry>(@aptos_mpp);
        let escrow_addr = registry.escrow_addr;

        assert!(table::contains(&registry.channels, channel_id), ECHANNEL_NOT_FOUND);
        let channel = table::borrow_mut(&mut registry.channels, channel_id);

        assert!(channel.client == sender_addr,    ENOT_AUTHORIZED);
        assert!(channel.is_open,                  ECHANNEL_EXPIRED);
        assert!(timestamp::now_seconds() < channel.expiry_timestamp, ECHANNEL_EXPIRED);
        assert!(channel.asset_metadata == meta_addr, EWRONG_ASSET);

        primary_fungible_store::transfer(sender, asset_metadata, escrow_addr, additional_amount);
        channel.balance = channel.balance + additional_amount;

        event::emit(ChannelToppedUp {
            channel_id,
            additional:  additional_amount,
            new_balance: channel.balance,
        });
    }

    // ── Close channel ─────────────────────────────────────────────────────

    /// Called by the recipient with the highest accepted voucher.
    /// `expiry` must equal `channel.expiry_timestamp` — it is part of the signed
    /// message so that vouchers cannot be replayed across channel lifetimes.
    public entry fun close_channel(
        recipient:         &signer,
        channel_id:        u64,
        asset_metadata:    Object<Metadata>,
        cumulative_amount: u64,
        nonce:             u64,
        expiry:            u64,
        client_signature:  vector<u8>,
    ) acquires ChannelRegistry {
        let recipient_addr = signer::address_of(recipient);
        let meta_addr      = object::object_address(&asset_metadata);

        let pay_amount:    u64;
        let refund_amount: u64;
        let client_addr:   address;

        // ── Phase 1: validate and mark closed (mutable borrow scope) ─────
        {
            let registry = borrow_global_mut<ChannelRegistry>(@aptos_mpp);
            assert!(table::contains(&registry.channels, channel_id), ECHANNEL_NOT_FOUND);
            let channel = table::borrow_mut(&mut registry.channels, channel_id);

            assert!(channel.recipient == recipient_addr, ENOT_AUTHORIZED);
            assert!(channel.is_open,                     ECHANNEL_EXPIRED);
            assert!(channel.asset_metadata == meta_addr, EWRONG_ASSET);
            // Server cannot close after expiry — client reclaims via expire_channel
            assert!(timestamp::now_seconds() < channel.expiry_timestamp, ECHANNEL_EXPIRED);
            // Signed expiry must match channel's expiry to prevent cross-lifetime replay
            assert!(expiry == channel.expiry_timestamp, ESTALE_VOUCHER);
            assert!(cumulative_amount > channel.cumulative_settled, ESTALE_VOUCHER);
            assert!(
                cumulative_amount <= channel.balance + channel.cumulative_settled,
                EINSUFFICIENT_BALANCE
            );

            let message = build_voucher_message(channel_id, cumulative_amount, nonce, expiry);
            let pk  = ed25519::new_unvalidated_public_key_from_bytes(channel.client_public_key);
            let sig = ed25519::new_signature_from_bytes(client_signature);
            assert!(
                ed25519::signature_verify_strict(&sig, &pk, message),
                EINVALID_SIGNATURE
            );

            pay_amount    = cumulative_amount - channel.cumulative_settled;
            refund_amount = channel.balance + channel.cumulative_settled - cumulative_amount;
            client_addr   = channel.client;

            channel.cumulative_settled = cumulative_amount;
            channel.balance            = 0;
            channel.is_open            = false;
        };
        // Mutable borrow on registry is fully released here.

        // ── Phase 2: transfer from escrow (fresh immutable borrow) ───────
        {
            let registry      = borrow_global<ChannelRegistry>(@aptos_mpp);
            let escrow_signer = account::create_signer_with_capability(&registry.signer_cap);
            primary_fungible_store::transfer(
                &escrow_signer, asset_metadata, recipient_addr, pay_amount
            );
            if (refund_amount > 0) {
                primary_fungible_store::transfer(
                    &escrow_signer, asset_metadata, client_addr, refund_amount
                );
            };
        };

        event::emit(ChannelClosed {
            channel_id,
            settled_amount:  pay_amount,
            refunded_amount: refund_amount,
        });
    }

    // ── Expire channel ────────────────────────────────────────────────────

    /// Force-close a channel that has passed its expiry. Returns balance to client.
    /// Anyone can call this — the refund goes to the channel's original client, not the caller.
    public entry fun expire_channel(
        _caller:    &signer,
        channel_id: u64,
    ) acquires ChannelRegistry {
        let refund_amount:   u64;
        let client_addr:     address;
        let asset_meta_addr: address;

        // ── Phase 1: mark expired (mutable borrow scope) ─────────────────
        {
            let registry = borrow_global_mut<ChannelRegistry>(@aptos_mpp);
            assert!(table::contains(&registry.channels, channel_id), ECHANNEL_NOT_FOUND);
            let channel = table::borrow_mut(&mut registry.channels, channel_id);

            assert!(channel.is_open, ECHANNEL_EXPIRED);
            assert!(
                timestamp::now_seconds() >= channel.expiry_timestamp,
                ECHANNEL_NOT_EXPIRED
            );

            refund_amount    = channel.balance;
            client_addr      = channel.client;
            asset_meta_addr  = channel.asset_metadata;

            channel.balance  = 0;
            channel.is_open  = false;
        };

        // ── Phase 2: refund from escrow ───────────────────────────────────
        if (refund_amount > 0) {
            let meta          = object::address_to_object<Metadata>(asset_meta_addr);
            let registry      = borrow_global<ChannelRegistry>(@aptos_mpp);
            let escrow_signer = account::create_signer_with_capability(&registry.signer_cap);
            primary_fungible_store::transfer(&escrow_signer, meta, client_addr, refund_amount);
        };

        event::emit(ChannelExpired {
            channel_id,
            refunded_amount: refund_amount,
        });
    }

    // ── View functions ────────────────────────────────────────────────────
    // #[view] is valid Aptos syntax. Do NOT use #[ext(view)] — that is Sui.

    #[view]
    public fun get_channel_balance(channel_id: u64): u64 acquires ChannelRegistry {
        let registry = borrow_global<ChannelRegistry>(@aptos_mpp);
        assert!(table::contains(&registry.channels, channel_id), ECHANNEL_NOT_FOUND);
        table::borrow(&registry.channels, channel_id).balance
    }

    #[view]
    public fun get_cumulative_settled(channel_id: u64): u64 acquires ChannelRegistry {
        let registry = borrow_global<ChannelRegistry>(@aptos_mpp);
        assert!(table::contains(&registry.channels, channel_id), ECHANNEL_NOT_FOUND);
        table::borrow(&registry.channels, channel_id).cumulative_settled
    }

    #[view]
    public fun is_channel_open(channel_id: u64): bool acquires ChannelRegistry {
        let registry = borrow_global<ChannelRegistry>(@aptos_mpp);
        if (!table::contains(&registry.channels, channel_id)) return false;
        table::borrow(&registry.channels, channel_id).is_open
    }

    #[view]
    public fun get_escrow_address(): address acquires ChannelRegistry {
        borrow_global<ChannelRegistry>(@aptos_mpp).escrow_addr
    }

    #[view]
    /// Returns the raw 32-byte Ed25519 public key the client registered when opening
    /// this channel. The server uses this to verify off-chain voucher signatures without
    /// trusting any client-supplied value.
    public fun get_client_public_key(channel_id: u64): vector<u8> acquires ChannelRegistry {
        let registry = borrow_global<ChannelRegistry>(@aptos_mpp);
        assert!(table::contains(&registry.channels, channel_id), ECHANNEL_NOT_FOUND);
        table::borrow(&registry.channels, channel_id).client_public_key
    }

    // ── Internal helpers ──────────────────────────────────────────────────

    /// Builds the 32-byte message that the client must sign with their Ed25519 key.
    /// Layout: SHA3-256(channel_id_le64 || cumulative_amount_le64 || nonce_le64 || expiry_le64)
    fun build_voucher_message(
        channel_id:        u64,
        cumulative_amount: u64,
        nonce:             u64,
        expiry:            u64,
    ): vector<u8> {
        let buf = vector::empty<u8>();
        encode_u64_le(&mut buf, channel_id);
        encode_u64_le(&mut buf, cumulative_amount);
        encode_u64_le(&mut buf, nonce);
        encode_u64_le(&mut buf, expiry);
        std::hash::sha3_256(buf)
    }

    /// Append the 8 little-endian bytes of `v` to `buf`.
    fun encode_u64_le(buf: &mut vector<u8>, v: u64) {
        let i: u64 = 0;
        while (i < 8) {
            // Cast to u8 AFTER masking — no 'as' without parentheses needed here.
           vector::push_back(buf, (((v >> ((i * 8) as u8)) & 0xFF) as u8));
            i = i + 1;
        }
    }

    // ── Unit Tests ────────────────────────────────────────────────────────

    #[test_only]
    use aptos_framework::account as acct;
    #[test_only]
    use aptos_framework::fungible_asset::{Self, MintRef, TransferRef};
    #[test_only]
    use aptos_framework::object::ConstructorRef;
    #[test_only]
    use std::option;
    #[test_only]
    use std::string;

    // Creates a minimal FA for testing. Returns (metadata object, mint_ref, transfer_ref).
    #[test_only]
    fun create_test_fa(creator: &signer): (Object<Metadata>, MintRef, TransferRef) {
        let constructor_ref: ConstructorRef = object::create_named_object(creator, b"TEST_FA");
        primary_fungible_store::create_primary_store_enabled_fungible_asset(
            &constructor_ref,
            option::none(),
            string::utf8(b"Test Token"),
            string::utf8(b"TT"),
            8,
            string::utf8(b""),
            string::utf8(b""),
        );
        let mint_ref     = fungible_asset::generate_mint_ref(&constructor_ref);
        let transfer_ref = fungible_asset::generate_transfer_ref(&constructor_ref);
        let metadata     = object::object_from_constructor_ref<Metadata>(&constructor_ref);
        (metadata, mint_ref, transfer_ref)
    }

    #[test_only]
    fun setup_framework(aptos_framework: &signer) {
        timestamp::set_time_has_started_for_testing(aptos_framework);
    }

    // Smoke test: open a channel, check balance and state.
    #[test(aptos_framework = @aptos_framework, deployer = @aptos_mpp, client = @0xCAFE)]
    public entry fun test_open_channel(
        aptos_framework: signer,
        deployer:        signer,
        client:          signer,
    ) acquires ChannelRegistry {
        setup_framework(&aptos_framework);
        acct::create_account_for_test(signer::address_of(&deployer));
        acct::create_account_for_test(signer::address_of(&client));

        initialize(&deployer);

        let (metadata, mint_ref, _transfer_ref) = create_test_fa(&deployer);

        // Mint 1_000_000 units to client
        let client_addr = signer::address_of(&client);
        let fa = fungible_asset::mint(&mint_ref, 1_000_000);
        primary_fungible_store::deposit(client_addr, fa);

        // Dummy Ed25519 public key (32 bytes of zeroes — won't pass sig verify but sufficient
        // to test channel open/state).
        let dummy_pubkey = vector::empty<u8>();
        let i = 0u64;
        while (i < 32) {
            vector::push_back(&mut dummy_pubkey, 0u8);
            i = i + 1;
        };

        // expiry = current time + 3600
        let expiry = timestamp::now_seconds() + 3600;

        open_channel(
            &client,
            signer::address_of(&deployer), // recipient = deployer for simplicity
            metadata,
            500_000,
            expiry,
            dummy_pubkey,
        );

        // Channel 0 should exist and hold 500_000
        assert!(is_channel_open(0), 1);
        assert!(get_channel_balance(0) == 500_000, 2);
    }

    // Test that expire_channel refunds the client after expiry.
    #[test(aptos_framework = @aptos_framework, deployer = @aptos_mpp, client = @0xCAFE)]
    public entry fun test_expire_channel(
        aptos_framework: signer,
        deployer:        signer,
        client:          signer,
    ) acquires ChannelRegistry {
        setup_framework(&aptos_framework);
        acct::create_account_for_test(signer::address_of(&deployer));
        acct::create_account_for_test(signer::address_of(&client));

        initialize(&deployer);

        let (metadata, mint_ref, _transfer_ref) = create_test_fa(&deployer);
        let client_addr = signer::address_of(&client);
        let fa = fungible_asset::mint(&mint_ref, 1_000_000);
        primary_fungible_store::deposit(client_addr, fa);

        let dummy_pubkey = vector::empty<u8>();
        let i = 0u64;
        while (i < 32) { vector::push_back(&mut dummy_pubkey, 0u8); i = i + 1; };

        // Expiry = now (already expired immediately for test purposes)
        let expiry = timestamp::now_seconds();

        open_channel(&client, signer::address_of(&deployer), metadata, 500_000, expiry, dummy_pubkey);

        // Anyone can call expire_channel
        expire_channel(&deployer, 0);

        // Channel is now closed
        assert!(!is_channel_open(0), 3);
        // Balance drained from escrow
        assert!(get_channel_balance(0) == 0, 4);
        // Client got refund
        assert!(primary_fungible_store::balance(client_addr, metadata) == 1_000_000, 5);
    }
}
