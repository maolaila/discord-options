// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Source copy of the already-deployed low-cost Base ledger used by this repo.
// Runtime publication only emits hashes; it never receives trading credentials.
contract TrackRecordLedgerLite {
    address public owner;

    enum RecordType {
        GENESIS_SNAPSHOT,
        LIVE_TRADE,
        BACKFILLED_TRADE,
        MONTHLY_SNAPSHOT,
        FILE_PUBLISHED,
        MANUAL_CORRECTION
    }

    event RecordCommitted(
        bytes32 indexed strategyId,
        bytes32 indexed recordId,
        RecordType recordType,
        bytes32 dataHash,
        string uri,
        uint256 sourceTimestamp,
        string schemaVersion,
        uint256 committedAt
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function transferOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero address");
        owner = newOwner;
    }

    function commitRecord(
        bytes32 strategyId,
        bytes32 recordId,
        RecordType recordType,
        bytes32 dataHash,
        string calldata uri,
        uint256 sourceTimestamp,
        string calldata schemaVersion
    ) external onlyOwner {
        emit RecordCommitted(
            strategyId,
            recordId,
            recordType,
            dataHash,
            uri,
            sourceTimestamp,
            schemaVersion,
            block.timestamp
        );
    }
}
