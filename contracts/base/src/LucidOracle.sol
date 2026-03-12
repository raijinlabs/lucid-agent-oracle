// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title LucidOracle — Publication-only oracle for Lucid Agent Economy feeds.
/// @notice Stores the latest report per feed. No business logic — receive signed reports, make them readable.
/// @dev Per-feed postReport (intentional deviation from bundled MVR). See spec for rationale.
contract LucidOracle {
    struct Report {
        uint64 reportTimestamp; // milliseconds since epoch (matches TypeScript Date.getTime())
        uint64 value;           // scaled by decimals
        uint8  decimals;
        uint16 confidence;     // basis points (9700 = 0.97)
        uint16 revision;
        bytes32 inputManifestHash;
        bytes32 computationHash;
    }

    address public authority;
    mapping(bytes16 => Report) public latestReports;

    event ReportPosted(
        bytes16 indexed feedId,
        uint64 value,
        uint64 reportTimestamp,
        uint16 confidence
    );
    event AuthorityRotated(address indexed oldAuthority, address indexed newAuthority);

    error NotAuthority();
    error StaleReport();
    error ZeroAddress();

    modifier onlyAuthority() {
        if (msg.sender != authority) revert NotAuthority();
        _;
    }

    constructor(address _authority) {
        authority = _authority;
    }

    /// @notice Post a new report for a feed. Enforces lexicographic freshness: newer timestamp wins,
    ///         or same timestamp with higher revision (restatement).
    function postReport(
        bytes16 feedId,
        uint64 value,
        uint8 decimals,
        uint16 confidence,
        uint16 revision,
        uint64 reportTimestamp,
        bytes32 inputManifestHash,
        bytes32 computationHash
    ) external onlyAuthority {
        Report storage current = latestReports[feedId];
        if (
            !(reportTimestamp > current.reportTimestamp ||
              (reportTimestamp == current.reportTimestamp && revision > current.revision))
        ) revert StaleReport();

        latestReports[feedId] = Report(
            reportTimestamp, value, decimals, confidence, revision,
            inputManifestHash, computationHash
        );
        emit ReportPosted(feedId, value, reportTimestamp, confidence);
    }

    /// @notice Get the latest report for a feed.
    function getLatestReport(bytes16 feedId) external view returns (Report memory) {
        return latestReports[feedId];
    }

    /// @notice Transfer authority to a new address.
    function rotateAuthority(address newAuthority) external onlyAuthority {
        if (newAuthority == address(0)) revert ZeroAddress();
        emit AuthorityRotated(authority, newAuthority);
        authority = newAuthority;
    }
}
