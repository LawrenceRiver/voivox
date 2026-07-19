import Foundation

public enum HoseConfigurationError: Error, Equatable, Sendable {
    case invalidMaximumNodeCount
    case invalidNaturalSegmentLength
    case invalidMaximumActiveLength
    case activeLengthExceedsTopology
    case invalidCompliance
    case invalidDamping
    case invalidSolverIterations
    case invalidMaximumStepDisplacement
}

public struct HoseConfiguration: Equatable, Sendable {
    public let maximumNodeCount: Int
    public let naturalSegmentLength: Double
    public let maximumActiveLength: Double
    public let stretchCompliance: Double
    public let bendCompliance: Double
    public let orientationCompliance: Double
    public let damping: Double
    public let solverIterations: Int
    public let maximumStepDisplacement: Double

    public init(
        maximumNodeCount: Int,
        naturalSegmentLength: Double,
        maximumActiveLength: Double,
        stretchCompliance: Double,
        bendCompliance: Double,
        orientationCompliance: Double,
        damping: Double,
        solverIterations: Int,
        maximumStepDisplacement: Double
    ) throws {
        guard (3...72).contains(maximumNodeCount) else {
            throw HoseConfigurationError.invalidMaximumNodeCount
        }
        guard naturalSegmentLength.isFinite, naturalSegmentLength > 0 else {
            throw HoseConfigurationError.invalidNaturalSegmentLength
        }
        guard maximumActiveLength.isFinite, maximumActiveLength > 0 else {
            throw HoseConfigurationError.invalidMaximumActiveLength
        }
        guard maximumActiveLength <= naturalSegmentLength * Double(maximumNodeCount - 1) else {
            throw HoseConfigurationError.activeLengthExceedsTopology
        }
        let compliances = [stretchCompliance, bendCompliance, orientationCompliance]
        guard compliances.allSatisfy({ $0.isFinite && $0 >= 0 }) else {
            throw HoseConfigurationError.invalidCompliance
        }
        guard damping.isFinite, (0...1).contains(damping) else {
            throw HoseConfigurationError.invalidDamping
        }
        guard solverIterations > 0 else {
            throw HoseConfigurationError.invalidSolverIterations
        }
        guard maximumStepDisplacement.isFinite, maximumStepDisplacement > 0 else {
            throw HoseConfigurationError.invalidMaximumStepDisplacement
        }

        self.maximumNodeCount = maximumNodeCount
        self.naturalSegmentLength = naturalSegmentLength
        self.maximumActiveLength = maximumActiveLength
        self.stretchCompliance = stretchCompliance
        self.bendCompliance = bendCompliance
        self.orientationCompliance = orientationCompliance
        self.damping = damping
        self.solverIterations = solverIterations
        self.maximumStepDisplacement = maximumStepDisplacement
    }

    public static let voiceVAC: HoseConfiguration = {
        // 71 deployable 32 pt bays provide 2,272 pt of exposed material.
        // That clears a large desktop diagonal while retaining the 72-node cap.
        try! HoseConfiguration(
            maximumNodeCount: 72,
            naturalSegmentLength: 32,
            maximumActiveLength: 2_272,
            stretchCompliance: 2e-8,
            bendCompliance: 2e-5,
            orientationCompliance: 1e-7,
            damping: 0.92,
            solverIterations: 20,
            maximumStepDisplacement: 160
        )
    }()
}
